#include "../src/capture.h"
#include "../src/preview_surface.h"
#include <iostream>
#include <chrono>
#include <stdexcept>

using namespace flip;
namespace flip {
class CaptureTestAccess {
public:
    static uint64_t Generation(Capture* capture) { return capture->generation_.load(); }
    static void OldCallback(Capture* capture, uint64_t generation) { capture->ReadSample(generation, E_FAIL, 0, nullptr); }
};
}
void Require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
void PreviewTests() {
    const DWORD initialHandles = GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS);
    HDC target = CreateCompatibleDC(nullptr);
    BITMAPINFO info = {}; info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = 96; info.bmiHeader.biHeight = -72;
    info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
    void* bits = nullptr;
    HBITMAP bitmap = CreateDIBSection(target, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
    Require(target && bitmap && bits, "Create preview test target");
    const auto old = SelectObject(target, bitmap);
    SetPixel(target, 32, 32, RGB(255, 0, 255));
    {
        PreviewSurface surface;
        std::vector<uint32_t> frame(64 * 48);
        COLORREF previous = GetPixel(target, 32, 32);
        for (int i = 0; i < 1000; ++i) {
            const bool red = (i & 1) == 0;
            std::fill(frame.begin(), frame.end(), red ? 0xFFFF0000 : 0xFF0000FF);
            Require(surface.Ensure(target, i % 3 == 0 ? 80 : 96, i % 3 == 0 ? 60 : 72), "Prepare preview back buffer");
            surface.Compose(frame, 64, 48, static_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT)));
            Require(GetPixel(target, 32, 32) == previous, "Composing must not clear or modify the visible target");
            surface.Present(target);
            const COLORREF expected = red ? RGB(255, 0, 0) : RGB(0, 0, 255);
            Require(GetPixel(target, 32, 32) == expected, "Present must copy the completed image without a black intermediate frame");
            previous = expected;
        }
    }
    SelectObject(target, old); DeleteObject(bitmap); DeleteDC(target);
    Require(GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS) == initialHandles, "Resizing preview buffers must not leak GDI handles");
    std::cout << "PASS: 1,000 buffered preview frames; composition leaves the prior frame intact; resize cleanup has no GDI leak\n";
}
void FrameTests() {
    constexpr unsigned w = 8, h = 4, pitch = 12;
    std::vector<uint8_t> padded(pitch * h * 3 / 2, 0xEE);
    for (unsigned y = 0; y < h; ++y) for (unsigned x = 0; x < w; ++x) padded[y * pitch + x] = uint8_t(y * 10 + x);
    for (unsigned y = 0; y < h / 2; ++y) for (unsigned x = 0; x < w; x += 2) {
        padded[pitch * h + y * pitch + x] = uint8_t(90 + x);
        padded[pitch * h + y * pitch + x + 1] = uint8_t(140 + x);
    }
    std::vector<uint8_t> normal, mirrored, back;
    PackNv12(padded.data(), pitch, w, h, PixelFormat::NV12, false, normal);
    PackNv12(padded.data(), pitch, w, h, PixelFormat::NV12, true, mirrored);
    Require(mirrored[0] == 7 && mirrored[7] == 0 && mirrored[8] == 17, "Y rows must reverse horizontally, preserving their order");
    Require(mirrored[w * h] == 96 && mirrored[w * h + 1] == 146, "UV pairs must reverse without swapping U and V");
    Require(normal[0] == 0 && normal[8] == 10 && normal[w * h] == 90, "Mirror off must remove padding without changing pixels");
    PackNv12(mirrored.data(), w, w, h, PixelFormat::NV12, true, back);
    Require(back == normal, "Mirroring twice must reproduce every NV12 byte exactly");

    std::vector<uint8_t> yuy2 = {10,20,11,30,12,40,13,50, 14,22,15,32,16,42,17,52};
    PackNv12(yuy2.data(), 8, 4, 2, PixelFormat::YUY2, true, back);
    Require(back[0] == 13 && back[3] == 10 && back[4] == 17, "YUY2 luma order");
    Require(back[8] == 41 && back[9] == 51 && back[10] == 21 && back[11] == 31, "YUY2 chroma downsample must retain UV pair order");

    std::vector<uint8_t> rgb(4 * 4 * 4);
    for (unsigned y = 0; y < 4; ++y) for (unsigned x = 0; x < 4; ++x) {
        auto* p = rgb.data() + (y * 4 + x) * 4; p[0] = uint8_t(y * 50); p[1] = 50; p[2] = uint8_t(x * 50); p[3] = 255;
    }
    std::vector<uint8_t> topDown, bottomUp(rgb.size());
    for (unsigned y = 0; y < 4; ++y) std::memcpy(bottomUp.data() + y * 16, rgb.data() + (3-y) * 16, 16);
    PackNv12(rgb.data(), 16, 4, 4, PixelFormat::BGRA, true, topDown);
    PackNv12(bottomUp.data() + 3 * 16, -16, 4, 4, PixelFormat::BGRA, true, back);
    Require(back == topDown, "Negative-stride RGB frames must remain upright");
    bool rejected = false; try { PackNv12(rgb.data(), 1, 4, 4, PixelFormat::BGRA, true, back); } catch (...) { rejected = true; }
    Require(rejected, "Reject insufficient row stride");
    rejected = false; try { PackNv12(rgb.data(), std::numeric_limits<ptrdiff_t>::min(), 4, 4, PixelFormat::BGRA, true, back); } catch (...) { rejected = true; }
    Require(rejected, "Reject signed-minimum stride without integer overflow");
    rejected = false; try { Nv12Size(3, 4); } catch (...) { rejected = true; }
    Require(rejected, "Reject odd-size NV12 frames");
    std::vector<uint8_t> pattern;
    MakePattern(8, 4, pattern); PackNv12(pattern.data(), 8, 8, 4, PixelFormat::NV12, true, back);
    std::vector<uint32_t> preview;
    MakePreview(back, 8, 4, preview, 8, 4, false);
    Require((preview[0] & 255) > ((preview[0] >> 16) & 255) + 100, "Mirrored source's left must be blue");
    Require(((preview[7] >> 16) & 255) > (preview[7] & 255) + 100, "Mirrored source's right must be red");
    std::cout << "PASS: NV12 stride / luma / UV pairs / exact double flip; YUY2; negative RGB stride; invalid input; preview colors\n";
}

int main(int argc, char** argv) {
    try {
        if (argc == 1) { FrameTests(); PreviewTests(); return 0; }
        HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        if (FAILED(hr) || FAILED(hr = MFStartup(MF_VERSION))) throw std::runtime_error("Could not initialize Windows camera APIs");
        ComPtr<Capture> capture; capture.Attach(new Capture());
        int result = 0;
        if (std::string(argv[1]) == "--list") {
            std::cout << "OBS Virtual Camera installed: " << (VirtualCameraInstalled() ? "yes" : "no") << '\n';
            auto devices = ListCameras();
            std::cout << "Source cameras: " << devices.size() << '\n';
            for (size_t i = 0; i < devices.size(); ++i) std::wcout << i << L": " << devices[i].name << L'\n';
        } else if (std::string(argv[1]) == "--publish") {
            if (FAILED(capture->StartPattern())) throw std::runtime_error("Virtual camera is busy");
            for (int i = 0; i < 100 && capture->Frames() < 2; ++i) Sleep(50);
            std::cout << "READY" << std::endl;
            for (std::string command; std::getline(std::cin, command); ) {
                if (command == "STOP") break;
                if (command == "ON" || command == "OFF") { capture->SetMirror(command == "ON"); std::cout << "MIRROR " << command << std::endl; }
            }
        } else if (std::string(argv[1]) == "--lifecycle") {
            Require(SUCCEEDED(capture->StartPattern()), "First publisher should start");
            for (int i = 0; i < 100 && capture->Frames() < 2; ++i) Sleep(25);
            Require(capture->Frames() >= 2, "First publisher should produce frames");
            const auto previousGeneration = CaptureTestAccess::Generation(capture.Get());
            ComPtr<Capture> other; other.Attach(new Capture());
            Require(FAILED(other->StartPattern()), "A competing publisher must be refused");
            Require(capture->Running(), "A refused publisher must not stop the original");
            other->Stop();
            auto* observer = video_queue_open();
            Require(observer != nullptr, "The queue should be readable");
            Require(video_queue_state(observer) == SHARED_QUEUE_STATE_READY, "The original queue must stay ready");
            capture->Stop();
            Require(video_queue_state(observer) == SHARED_QUEUE_STATE_STOPPING, "Stop must tell consumers to release the queue");
            video_queue_close(observer);
            Require(SUCCEEDED(other->StartPattern()), "A publisher should restart after cleanup");
            other->Stop();
            Require(SUCCEEDED(capture->StartPattern()), "Original capture object should restart");
            CaptureTestAccess::OldCallback(capture.Get(), previousGeneration);
            Require(capture->Running() && capture->LastError().empty(), "An old camera callback must not fail the new session");
            capture->Stop();
            std::cout << "PASS: competing publisher rejected; original preserved; stop and restart release resources\n";
            std::cout << "PASS: stale callback from an old session cannot alter a restarted camera\n";
        } else if (std::string(argv[1]) == "--camera-restart-check") {
            const auto devices = ListCameras();
            Require(!devices.empty(), "No physical camera connected");
            for (int i = 0; i < 3; ++i) {
                if (FAILED(capture->Start(devices[0].link, nullptr))) { std::wcerr << capture->LastError() << L'\n'; throw std::runtime_error("Camera restart failed"); }
                for (int poll = 0; poll < 100 && capture->Frames() < 10 && capture->Running(); ++poll) Sleep(50);
                Require(capture->Frames() >= 10 && capture->LastError().empty(), "Restart must capture live frames without session errors");
                capture->Stop();
            }
            std::cout << "PASS: physical camera starts, captures, and stops across three independent sessions\n";
        } else if (std::string(argv[1]) == "--camera-check") {
            const auto devices = ListCameras();
            if (devices.empty()) throw std::runtime_error("No camera connected");
            if (FAILED(capture->Start(devices[0].link, nullptr))) {
                std::wcerr << capture->LastError() << '\n'; result = 1;
            } else {
                Sleep(3000);
                std::wcout << capture->FormatDescription() << L'\n';
                std::cout << "Captured frames: " << capture->Frames() << '\n';
                result = capture->Frames() > 5 ? 0 : 1;
                if (!capture->LastError().empty()) std::wcerr << capture->LastError() << '\n';
            }
        } else throw std::runtime_error("Unknown test command");
        capture->Stop(); capture.Reset(); MFShutdown(); CoUninitialize(); return result;
    } catch (const std::exception& error) { std::cerr << "FAIL: " << error.what() << '\n'; return 1; }
}
