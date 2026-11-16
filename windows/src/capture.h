#pragma once
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>
#include <atomic>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <new>
#include "frame_ops.h"
#include "../vendor/obs/shared-memory-queue.h"

namespace flip {
using Microsoft::WRL::ComPtr;
constexpr UINT WM_CAPTURE_FRAME = WM_APP + 1;
constexpr UINT WM_CAPTURE_ERROR = WM_APP + 2;
struct Device { std::wstring name, link; };
std::vector<Device> ListCameras();
bool VirtualCameraInstalled();
std::wstring ErrorText(HRESULT error);

class CaptureCallback;

class Capture final : public IUnknown {
public:
    Capture();
    STDMETHODIMP QueryInterface(REFIID iid, void** out) override;
    STDMETHODIMP_(ULONG) AddRef() override;
    STDMETHODIMP_(ULONG) Release() override;

    // Start / Stop must be serialized by the controller, never by the UI callback.
    HRESULT Start(const std::wstring& link, HWND notify);
    HRESULT StartPattern(HWND notify = nullptr);
    void Stop();
    void SetMirror(bool value) { mirrored_.store(value); }
    bool Mirrored() const { return mirrored_.load(); }
    bool Running() const { return running_.load(); }
    uint64_t Frames() const { return frames_.load(); }
    std::wstring LastError();
    std::wstring FormatDescription();
    bool Preview(std::vector<uint32_t>& pixels, unsigned& width, unsigned& height);

private:
    friend class CaptureCallback;
    friend class CaptureTestAccess;
    ~Capture();
    HRESULT ReadSample(uint64_t generation, HRESULT status, DWORD flags, IMFSample* sample);
    void Fail(HRESULT hr, const wchar_t* context);
    HRESULT RefreshFormat();
    HRESULT Process(IMFSample* sample);
    void Publish(const uint8_t* first, ptrdiff_t stride);
    void RequestSample(uint64_t generation);
    std::atomic<ULONG> refs_{1};
    std::atomic<bool> running_{false}, mirrored_{true};
    std::atomic<uint64_t> frames_{0};
    std::atomic<uint64_t> generation_{0};
    std::atomic<bool> previewPending_{false};
    std::mutex control_, frame_, info_, callbackWork_;
    ComPtr<IMFSourceReader> reader_;
    ComPtr<IMFMediaSource> source_;
    ComPtr<CaptureCallback> callback_;
    HWND notify_ = nullptr;
    video_queue_t* queue_ = nullptr;
    std::thread patternThread_;
    unsigned width_ = 0, height_ = 0, fpsNum_ = 30, fpsDen_ = 1;
    LONG stride_ = 0;
    PixelFormat format_ = PixelFormat::NV12;
    bool bt709_ = false;
    std::wstring error_, description_;
    std::vector<uint8_t> output_;
    std::vector<uint32_t> preview_;
    unsigned previewW_ = 0, previewH_ = 0;
    LARGE_INTEGER clockFrequency_ = {};
};
} // namespace flip
