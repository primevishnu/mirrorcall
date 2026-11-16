#include "capture.h"
#include <mferror.h>
#include <dshow.h>
#include <cmath>
#include <iomanip>
#include <sstream>

namespace flip {
constexpr DWORD VIDEO_STREAM = static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM);
constexpr DWORD ALL_STREAMS = static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS);

// One callback object per camera session. A delayed callback from an old source
// cannot touch a newly-started camera, and each flush signals its own event.
class CaptureCallback final : public IMFSourceReaderCallback {
public:
    CaptureCallback(Capture* owner, uint64_t generation) : owner_(owner), generation_(generation) {
        flushed_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    }
    HANDLE FlushedEvent() const { return flushed_; }
    STDMETHODIMP QueryInterface(REFIID iid, void** out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (iid == __uuidof(IUnknown) || iid == __uuidof(IMFSourceReaderCallback)) {
            *out = static_cast<IMFSourceReaderCallback*>(this); AddRef(); return S_OK;
        }
        return E_NOINTERFACE;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return ++refs_; }
    STDMETHODIMP_(ULONG) Release() override { const auto refs = --refs_; if (!refs) delete this; return refs; }
    STDMETHODIMP OnReadSample(HRESULT status, DWORD, DWORD flags, LONGLONG, IMFSample* sample) override {
        return owner_->ReadSample(generation_, status, flags, sample);
    }
    STDMETHODIMP OnEvent(DWORD, IMFMediaEvent*) override { return S_OK; }
    STDMETHODIMP OnFlush(DWORD) override { SetEvent(flushed_); return S_OK; }
private:
    ~CaptureCallback() { if (flushed_) CloseHandle(flushed_); }
    std::atomic<ULONG> refs_{1};
    ComPtr<Capture> owner_;
    const uint64_t generation_;
    HANDLE flushed_ = nullptr;
};
std::wstring ErrorText(HRESULT error) {
    wchar_t* message = nullptr;
    FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr, DWORD(error), 0, reinterpret_cast<wchar_t*>(&message), 0, nullptr);
    std::wstringstream text;
    if (message) { text << message; LocalFree(message); }
    text << L" (0x" << std::hex << std::uppercase << unsigned(error) << L")";
    return text.str();
}

std::vector<Device> ListCameras() {
    std::vector<Device> result;
    ComPtr<IMFAttributes> attributes;
    if (FAILED(MFCreateAttributes(&attributes, 1))) return result;
    attributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
    IMFActivate** devices = nullptr; UINT32 count = 0;
    if (FAILED(MFEnumDeviceSources(attributes.Get(), &devices, &count))) return result;
    for (UINT32 i = 0; i < count; ++i) {
        wchar_t *name = nullptr, *link = nullptr; UINT32 length = 0;
        if (SUCCEEDED(devices[i]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &name, &length)) &&
            SUCCEEDED(devices[i]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, &link, &length))) {
            // A virtual camera fed back into itself can never produce useful frames.
            std::wstring lower(name);
            std::transform(lower.begin(), lower.end(), lower.begin(), towlower);
            if (lower.find(L"obs virtual") == std::wstring::npos) result.push_back({name, link});
        }
        CoTaskMemFree(name); CoTaskMemFree(link); devices[i]->Release();
    }
    CoTaskMemFree(devices);
    return result;
}

bool VirtualCameraInstalled() {
    ComPtr<ICreateDevEnum> enumerator;
    if (FAILED(CoCreateInstance(CLSID_SystemDeviceEnum, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&enumerator)))) return false;
    ComPtr<IEnumMoniker> monikers;
    if (enumerator->CreateClassEnumerator(CLSID_VideoInputDeviceCategory, &monikers, 0) != S_OK) return false;
    ComPtr<IMoniker> moniker;
    while (monikers->Next(1, &moniker, nullptr) == S_OK) {
        ComPtr<IPropertyBag> bag;
        if (SUCCEEDED(moniker->BindToStorage(nullptr, nullptr, IID_PPV_ARGS(&bag)))) {
            VARIANT name; VariantInit(&name);
            if (SUCCEEDED(bag->Read(L"FriendlyName", &name, nullptr)) && name.vt == VT_BSTR) {
                const bool found = std::wstring(name.bstrVal).find(L"OBS Virtual Camera") != std::wstring::npos;
                VariantClear(&name); if (found) return true;
            } else VariantClear(&name);
        }
        moniker.Reset();
    }
    return false;
}

Capture::Capture() { QueryPerformanceFrequency(&clockFrequency_); }
Capture::~Capture() { Stop(); }
STDMETHODIMP Capture::QueryInterface(REFIID iid, void** out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (iid == __uuidof(IUnknown)) {
        *out = static_cast<IUnknown*>(this); AddRef(); return S_OK;
    }
    return E_NOINTERFACE;
}
STDMETHODIMP_(ULONG) Capture::AddRef() { return ++refs_; }
STDMETHODIMP_(ULONG) Capture::Release() { ULONG left = --refs_; if (!left) delete this; return left; }

void Capture::Fail(HRESULT hr, const wchar_t* context) {
    running_.store(false);
    { std::lock_guard<std::mutex> lock(info_); error_ = std::wstring(context) + L"\n" + ErrorText(hr); }
    if (notify_) PostMessageW(notify_, WM_CAPTURE_ERROR, 0, 0);
}
std::wstring Capture::LastError() { std::lock_guard<std::mutex> lock(info_); return error_; }
std::wstring Capture::FormatDescription() { std::lock_guard<std::mutex> lock(info_); return description_; }
bool Capture::Preview(std::vector<uint32_t>& pixels, unsigned& width, unsigned& height) {
    std::lock_guard<std::mutex> lock(frame_);
    previewPending_ = false;
    pixels = preview_; width = previewW_; height = previewH_;
    return !pixels.empty();
}

HRESULT Capture::RefreshFormat() {
    ComPtr<IMFMediaType> type;
    HRESULT hr = reader_->GetCurrentMediaType(VIDEO_STREAM, &type);
    if (FAILED(hr)) return hr;
    GUID subtype = {}; UINT32 w = 0, h = 0;
    if (FAILED(hr = type->GetGUID(MF_MT_SUBTYPE, &subtype)) || FAILED(hr = MFGetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, &w, &h))) return hr;
    if (width_ && (w != width_ || h != height_)) return MF_E_INVALIDMEDIATYPE;
    if (subtype == MFVideoFormat_NV12) format_ = PixelFormat::NV12;
    else if (subtype == MFVideoFormat_YUY2) format_ = PixelFormat::YUY2;
    else if (subtype == MFVideoFormat_RGB32 || subtype == MFVideoFormat_ARGB32) format_ = PixelFormat::BGRA;
    else return MF_E_INVALIDMEDIATYPE;
    try { Nv12Size(w, h); } catch (...) { return MF_E_INVALIDMEDIATYPE; }
    width_ = w; height_ = h;
    UINT32 stride;
    if (SUCCEEDED(type->GetUINT32(MF_MT_DEFAULT_STRIDE, &stride))) stride_ = LONG(stride);
    else stride_ = LONG(width_ * (format_ == PixelFormat::BGRA ? 4 : format_ == PixelFormat::YUY2 ? 2 : 1));
    if (FAILED(MFGetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, &fpsNum_, &fpsDen_)) || !fpsNum_ || !fpsDen_) { fpsNum_ = 30; fpsDen_ = 1; }
    bt709_ = MFGetAttributeUINT32(type.Get(), MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT601) == MFVideoTransferMatrix_BT709;
    { std::lock_guard<std::mutex> lock(info_);
      const wchar_t* mode = format_ == PixelFormat::NV12 ? L"NV12" : format_ == PixelFormat::YUY2 ? L"YUY2" : L"RGB";
      description_ = std::to_wstring(width_) + L" × " + std::to_wstring(height_) + L" · " + std::to_wstring(unsigned(std::round(double(fpsNum_) / fpsDen_))) + L" fps · " + mode;
    }
    return S_OK;
}

HRESULT Capture::Start(const std::wstring& link, HWND notify) {
    Stop(); notify_ = notify; frames_ = 0; width_ = height_ = 0;
    { std::lock_guard<std::mutex> lock(info_); error_.clear(); }
    if (auto* existing = video_queue_open()) {
        video_queue_close(existing);
        const auto busy = HRESULT_FROM_WIN32(ERROR_BUSY);
        Fail(busy, L"OBS Virtual Camera is busy. Stop its other publisher before starting this camera."); return busy;
    }
    ComPtr<IMFAttributes> attributes;
    HRESULT hr = MFCreateAttributes(&attributes, 2);
    if (FAILED(hr)) { Fail(hr, L"Could not initialize camera attributes."); return hr; }
    if (FAILED(hr = attributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID)) ||
        FAILED(hr = attributes->SetString(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, link.c_str()))) {
        Fail(hr, L"Could not configure the selected camera."); return hr;
    }
    ComPtr<IMFMediaSource> source;
    if (FAILED(hr = MFCreateDeviceSource(attributes.Get(), &source))) { Fail(hr, L"Could not open the camera. Close other camera apps and check Windows camera permissions."); return hr; }
    ComPtr<IMFAttributes> options;
    ComPtr<CaptureCallback> callback;
    const auto generation = generation_.load();
    callback.Attach(new (std::nothrow) CaptureCallback(this, generation));
    if (!callback || !callback->FlushedEvent()) {
        source->Shutdown(); Fail(E_OUTOFMEMORY, L"Could not allocate the camera callback."); return E_OUTOFMEMORY;
    }
    if (FAILED(hr = MFCreateAttributes(&options, 4)) ||
        FAILED(hr = options->SetUnknown(MF_SOURCE_READER_ASYNC_CALLBACK, callback.Get())) ||
        FAILED(hr = options->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE)) ||
        FAILED(hr = options->SetUINT32(MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, TRUE))) {
        source->Shutdown(); Fail(hr, L"Could not initialize Windows capture options."); return hr;
    }
    ComPtr<IMFSourceReader> reader;
    if (FAILED(hr = MFCreateSourceReaderFromMediaSource(source.Get(), options.Get(), &reader))) {
        source->Shutdown(); Fail(hr, L"Could not start Windows camera capture."); return hr;
    }
    { std::lock_guard<std::mutex> lock(control_); reader_ = reader; source_ = source; callback_ = callback; }
    if (FAILED(hr = reader->SetStreamSelection(ALL_STREAMS, FALSE)) || FAILED(hr = reader->SetStreamSelection(VIDEO_STREAM, TRUE))) {
        Fail(hr, L"The camera has no accessible video stream."); Stop(); return hr;
    }
    // Prefer the camera's highest native resolution at up to 1080p and 30 fps.
    // This cap avoids an unnecessary 4K processing/USB load for video calls.
    struct Candidate { ComPtr<IMFMediaType> type; double score; UINT32 w, h, n, d; };
    std::vector<Candidate> candidates;
    for (DWORD i = 0; i < 1024; ++i) {
        ComPtr<IMFMediaType> type;
        if (FAILED(reader->GetNativeMediaType(VIDEO_STREAM, i, &type))) break;
        UINT32 w = 0, h = 0, n = 0, d = 1; GUID subtype = {};
        if (FAILED(MFGetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, &w, &h)) || !w || !h || (w & 1) || (h & 1) || w > 4096 || h > 2160) continue;
        type->GetGUID(MF_MT_SUBTYPE, &subtype);
        if (subtype != MFVideoFormat_NV12 && subtype != MFVideoFormat_YUY2 && subtype != MFVideoFormat_UYVY &&
            subtype != MFVideoFormat_I420 && subtype != MFVideoFormat_IYUV && subtype != MFVideoFormat_YV12 &&
            subtype != MFVideoFormat_MJPG && subtype != MFVideoFormat_H264 && subtype != MFVideoFormat_RGB24 &&
            subtype != MFVideoFormat_RGB32 && subtype != MFVideoFormat_ARGB32) continue;
        if (FAILED(MFGetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, &n, &d)) || !n || !d) { n = 30; d = 1; }
        const double fps = double(n) / d;
        double score = double(w) * h + std::min(fps, 30.0) * 1000;
        if (w > 1920 || h > 1080) score -= 1e9;
        if (fps > 30.5) score -= 1e8;
        if (subtype == MFVideoFormat_NV12) score += 100;
        candidates.push_back({type, score, w, h, n, d});
    }
    if (candidates.empty()) { Fail(MF_E_INVALIDMEDIATYPE, L"No supported camera format was found."); Stop(); return MF_E_INVALIDMEDIATYPE; }
    std::stable_sort(candidates.begin(), candidates.end(), [](const Candidate& a, const Candidate& b) { return a.score > b.score; });
    const GUID outputs[] = {MFVideoFormat_NV12, MFVideoFormat_YUY2, MFVideoFormat_RGB32};
    bool configured = false;
    // A camera's advertised "best" type may not be convertible on this PC.
    // Try its other native modes rather than rejecting the whole device.
    for (const auto& candidate : candidates) {
        hr = reader->SetCurrentMediaType(VIDEO_STREAM, nullptr, candidate.type.Get());
        if (FAILED(hr)) continue;
        for (const GUID& format : outputs) {
            ComPtr<IMFMediaType> output;
            if (FAILED(hr = MFCreateMediaType(&output))) break;
            if (FAILED(hr = output->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video)) ||
                FAILED(hr = output->SetGUID(MF_MT_SUBTYPE, format)) ||
                FAILED(hr = MFSetAttributeSize(output.Get(), MF_MT_FRAME_SIZE, candidate.w, candidate.h)) ||
                FAILED(hr = MFSetAttributeRatio(output.Get(), MF_MT_FRAME_RATE, candidate.n, candidate.d))) continue;
            hr = reader->SetCurrentMediaType(VIDEO_STREAM, nullptr, output.Get());
            if (SUCCEEDED(hr) && SUCCEEDED(hr = RefreshFormat())) { configured = true; break; }
            width_ = height_ = 0;
        }
        if (configured) break;
    }
    if (!configured) { Fail(hr, L"Windows could not convert this camera to a supported video format."); Stop(); return hr; }
    const uint64_t interval = uint64_t(fpsDen_) * 10'000'000 / fpsNum_;
    queue_ = video_queue_create(width_, height_, interval);
    if (!queue_) { Fail(HRESULT_FROM_WIN32(ERROR_BUSY), L"OBS Virtual Camera is busy. Stop its output in OBS or another app, then try again."); Stop(); return HRESULT_FROM_WIN32(ERROR_BUSY); }
    running_ = true;
    RequestSample(generation);
    if (!running_) { Stop(); return E_FAIL; }
    return S_OK;
}

void Capture::RequestSample(uint64_t generation) {
    ComPtr<IMFSourceReader> reader;
    { std::lock_guard<std::mutex> lock(control_); if (!running_ || generation != generation_) return; reader = reader_; }
    if (!reader) return;
    HRESULT hr = reader->ReadSample(VIDEO_STREAM, 0, nullptr, nullptr, nullptr, nullptr);
    if (FAILED(hr) && running_ && generation == generation_) Fail(hr, L"The camera stopped responding. Stop and start the camera again.");
}

void Capture::Publish(const uint8_t* first, ptrdiff_t stride) {
    std::lock_guard<std::mutex> lock(frame_);
    if (!running_ || !queue_) return;
    PackNv12(first, stride, width_, height_, format_, mirrored_.load(), output_);
    uint8_t* planes[] = {output_.data(), output_.data() + size_t(width_) * height_};
    uint32_t pitches[] = {width_, width_};
    LARGE_INTEGER qpc; QueryPerformanceCounter(&qpc);
    const uint64_t ns = uint64_t(double(qpc.QuadPart) * 1e9 / double(clockFrequency_.QuadPart));
    video_queue_write(queue_, planes, pitches, ns);
    const auto frame = ++frames_;
    const uint64_t divisor = std::max<uint64_t>(1, (uint64_t(fpsNum_) + 30ULL * fpsDen_ - 1) / (30ULL * fpsDen_));
    if (notify_ && frame % divisor == 0 && IsWindowVisible(notify_) && !IsIconic(notify_)) {
        const double scale = std::min(384.0 / width_, 216.0 / height_);
        previewW_ = std::max(2U, unsigned(width_ * scale)); previewH_ = std::max(2U, unsigned(height_ * scale));
        MakePreview(output_, width_, height_, preview_, previewW_, previewH_, bt709_);
        if (!previewPending_.exchange(true) && !PostMessageW(notify_, WM_CAPTURE_FRAME, 0, 0)) previewPending_ = false;
    }
}

HRESULT Capture::Process(IMFSample* sample) {
    ComPtr<IMFMediaBuffer> buffer;
    HRESULT hr = sample->ConvertToContiguousBuffer(&buffer);
    if (FAILED(hr)) return hr;
    ComPtr<IMF2DBuffer2> surface;
    if (SUCCEEDED(buffer.As(&surface))) {
        BYTE *first = nullptr, *start = nullptr; LONG pitch = 0; DWORD length = 0;
        if (SUCCEEDED(hr = surface->Lock2DSize(MF2DBuffer_LockFlags_Read, &first, &pitch, &start, &length))) {
            const size_t rowBytes = size_t(width_) * (format_ == PixelFormat::BGRA ? 4 : format_ == PixelFormat::YUY2 ? 2 : 1);
            const size_t rows = format_ == PixelFormat::NV12 ? height_ * 3 / 2 : height_;
            const auto startAddress = reinterpret_cast<uintptr_t>(start);
            const auto firstAddress = reinterpret_cast<uintptr_t>(first);
            const int64_t firstOffset = firstAddress >= startAddress && firstAddress - startAddress <= length
                ? int64_t(firstAddress - startAddress) : -1;
            const int64_t lastOffset = firstOffset + int64_t(rows - 1) * pitch;
            const int64_t low = std::min(firstOffset, lastOffset), high = std::max(firstOffset, lastOffset);
            // Validate offsets as integers before forming any pointer outside
            // the returned mapping, including bottom-up and padded buffers.
            if (firstOffset < 0 || low < 0 || high > length || rowBytes > size_t(length - high)) hr = MF_E_BUFFERTOOSMALL;
            else { try { Publish(first, pitch); } catch (...) { hr = MF_E_INVALIDMEDIATYPE; } }
            surface->Unlock2D(); return hr;
        }
    }
    BYTE* data = nullptr; DWORD maxLength = 0, length = 0;
    if (FAILED(hr = buffer->Lock(&data, &maxLength, &length))) return hr;
    const size_t pitch = size_t(stride_ < 0 ? -int64_t(stride_) : stride_);
    const size_t rows = format_ == PixelFormat::NV12 ? height_ * 3 / 2 : height_;
    const size_t rowBytes = size_t(width_) * (format_ == PixelFormat::BGRA ? 4 : format_ == PixelFormat::YUY2 ? 2 : 1);
    if (!rows || (rows - 1) * pitch + rowBytes > length) hr = MF_E_BUFFERTOOSMALL;
    else {
        const auto* first = stride_ < 0 ? data + (height_ - 1) * pitch : data;
        try { Publish(first, stride_); } catch (...) { hr = MF_E_INVALIDMEDIATYPE; }
    }
    buffer->Unlock(); return hr;
}

HRESULT Capture::ReadSample(uint64_t generation, HRESULT status, DWORD flags, IMFSample* sample) {
    std::lock_guard<std::mutex> callbackLock(callbackWork_);
    if (!running_ || generation != generation_) return S_OK;
    if (FAILED(status)) { Fail(status, L"Camera capture failed. Check permissions or reconnect the camera."); return S_OK; }
    if (flags & MF_SOURCE_READERF_ENDOFSTREAM) { Fail(MF_E_END_OF_STREAM, L"The camera disconnected."); return S_OK; }
    if (flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED) {
        HRESULT hr = RefreshFormat();
        if (FAILED(hr)) { Fail(hr, L"The camera changed video format. Please restart capture."); return S_OK; }
    }
    if (sample) {
        HRESULT hr = Process(sample);
        if (FAILED(hr)) { Fail(hr, L"The camera returned an unsupported or incomplete frame."); return S_OK; }
    }
    RequestSample(generation); return S_OK;
}

HRESULT Capture::StartPattern(HWND notify) {
    Stop(); notify_ = notify; frames_ = 0; width_ = 1280; height_ = 720; fpsNum_ = 30; fpsDen_ = 1;
    stride_ = width_; format_ = PixelFormat::NV12; bt709_ = false;
    { std::lock_guard<std::mutex> lock(info_); error_.clear(); description_ = L"1280 × 720 · 30 fps · Test pattern"; }
    queue_ = video_queue_create(width_, height_, 333333);
    if (!queue_) { Fail(HRESULT_FROM_WIN32(ERROR_BUSY), L"The virtual camera is already in use by another publisher."); return HRESULT_FROM_WIN32(ERROR_BUSY); }
    running_ = true;
    patternThread_ = std::thread([this] {
        std::vector<uint8_t> frame; MakePattern(width_, height_, frame);
        auto next = std::chrono::steady_clock::now();
        while (running_) { Publish(frame.data(), width_); next += std::chrono::microseconds(33333); std::this_thread::sleep_until(next); }
    });
    return S_OK;
}

void Capture::Stop() {
    running_ = false;
    ++generation_;
    if (patternThread_.joinable()) patternThread_.join();
    ComPtr<IMFSourceReader> reader;
    ComPtr<IMFMediaSource> source;
    ComPtr<CaptureCallback> callback;
    { std::lock_guard<std::mutex> lock(control_); reader = reader_; source = source_; callback = callback_; }
    if (reader && callback) {
        ResetEvent(callback->FlushedEvent());
        if (SUCCEEDED(reader->Flush(VIDEO_STREAM))) WaitForSingleObject(callback->FlushedEvent(), 3000);
    }
    if (source) source->Shutdown();
    // A buggy device can take longer than the flush wait. Drain an in-progress
    // callback before reusing frame geometry or releasing the session's reader.
    std::lock_guard<std::mutex> callbackLock(callbackWork_);
    { std::lock_guard<std::mutex> lock(control_); reader_.Reset(); source_.Reset(); callback_.Reset(); }
    { std::lock_guard<std::mutex> lock(frame_);
      video_queue_close(queue_); queue_ = nullptr;
      output_.clear(); preview_.clear(); previewW_ = previewH_ = 0;
      previewPending_ = false;
    }
}
} // namespace flip
