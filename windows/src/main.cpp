#include "capture.h"
#include "preview_surface.h"
#include "app_version.h"
#include <commctrl.h>
#include <shellapi.h>
#include <memory>

using namespace flip;
namespace {
constexpr UINT WM_CONTROL_DONE = WM_APP + 10;
constexpr int ID_START = 100, ID_MIRROR = 101, ID_CAMERA = 102, ID_REFRESH = 103, ID_SETUP = 104;
#ifdef CAMERA_FLIP_GUI_TEST
constexpr wchar_t CLASS_NAME[] = L"MirrorCall.CameraFlip.Test";
constexpr wchar_t MUTEX_NAME[] = L"Local\\MirrorCall.CameraFlip.TestApplication";
#else
constexpr wchar_t CLASS_NAME[] = L"MirrorCall.CameraFlip.Main";
constexpr wchar_t MUTEX_NAME[] = L"Local\\MirrorCall.CameraFlip.Application";
#endif
ComPtr<Capture> capture;
std::vector<Device> cameras;
HWND window, cameraBox, mirrorBox, startButton, refreshButton, statusLabel, previewWindow;
HFONT font, titleFont;
std::thread controller;
bool busy = false, started = false, closing = false, installed = false;
int dpi = 96;
int S(int value) { return MulDiv(value, dpi, 96); }

void SetStatus(const std::wstring& value) { SetWindowTextW(statusLabel, value.c_str()); }
HWND Child(const wchar_t* cls, const wchar_t* text, DWORD style, int x, int y, int w, int h, int id = 0) {
    HWND child = CreateWindowExW(0, cls, text, WS_CHILD | WS_VISIBLE | style, S(x), S(y), S(w), S(h), window, reinterpret_cast<HMENU>(INT_PTR(id)), GetModuleHandleW(nullptr), nullptr);
    SendMessageW(child, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
    return child;
}
void Refresh() {
    if (busy || started) return;
#ifdef CAMERA_FLIP_GUI_TEST
    installed = true; cameras = {{L"Synthetic camera (test only)", L""}};
#else
    installed = VirtualCameraInstalled();
    cameras = ListCameras();
#endif
    SendMessageW(cameraBox, CB_RESETCONTENT, 0, 0);
    for (const auto& camera : cameras) SendMessageW(cameraBox, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(camera.name.c_str()));
    if (!cameras.empty()) SendMessageW(cameraBox, CB_SETCURSEL, 0, 0);
    EnableWindow(startButton, installed && !cameras.empty());
    SetStatus(!installed ? L"OBS Virtual Camera is not registered. See OBS setup below."
        : cameras.empty() ? L"No source camera found. Connect a webcam, then click Refresh."
        : L"Ready. Camera capture starts only when you click Start camera.");
}
void BeginControl(bool start) {
    if (busy) return;
    const LRESULT index = SendMessageW(cameraBox, CB_GETCURSEL, 0, 0);
    if (start && (index == CB_ERR || size_t(index) >= cameras.size())) return;
    if (controller.joinable()) controller.join();
    const std::wstring link = start ? cameras[size_t(index)].link : L"";
    busy = true;
    EnableWindow(startButton, FALSE); EnableWindow(cameraBox, FALSE); EnableWindow(refreshButton, FALSE);
    SetStatus(start ? L"Opening camera…" : L"Stopping and releasing camera…");
    try {
        controller = std::thread([start, link] {
            const HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
            HRESULT hr = com;
            if (SUCCEEDED(com)) {
#ifdef CAMERA_FLIP_GUI_TEST
                hr = start ? capture->StartPattern(window) : (capture->Stop(), S_OK);
#else
                hr = start ? capture->Start(link, window) : (capture->Stop(), S_OK);
#endif
                CoUninitialize();
            }
            PostMessageW(window, WM_CONTROL_DONE, start, hr);
        });
    } catch (const std::exception&) {
        busy = false;
        EnableWindow(startButton, installed && !cameras.empty());
        EnableWindow(cameraBox, !started); EnableWindow(refreshButton, !started);
        SetStatus(L"Windows could not start the capture worker. Try again.");
    }
}
LRESULT CALLBACK PreviewProc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == WM_NCCREATE) {
        auto* surface = new (std::nothrow) PreviewSurface();
        if (!surface) return FALSE;
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(surface));
        return TRUE;
    }
    if (message == WM_NCDESTROY) {
        delete reinterpret_cast<PreviewSurface*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }
    if (message == WM_ERASEBKGND) return 1;
    if (message != WM_PAINT) return DefWindowProcW(hwnd, message, wparam, lparam);
    PAINTSTRUCT paint; HDC dc = BeginPaint(hwnd, &paint);
    RECT rect; GetClientRect(hwnd, &rect);
    std::vector<uint32_t> pixels; unsigned width = 0, height = 0;
    if (capture) capture->Preview(pixels, width, height);
    auto* surface = reinterpret_cast<PreviewSurface*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    if (surface && surface->Ensure(dc, rect.right, rect.bottom)) {
        surface->Compose(pixels, width, height, font);
        surface->Present(dc);
    }
    EndPaint(hwnd, &paint); return 0;
}
LRESULT CALLBACK WindowProc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
    switch (message) {
    case WM_CREATE: {
        window = hwnd;
        dpi = int(GetDpiForWindow(hwnd));
        font = CreateFontW(-S(14), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
        titleFont = CreateFontW(-S(26), 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
        HWND title = Child(L"STATIC", L"Camera Flip", 0, 24, 16, 480, 36); SendMessageW(title, WM_SETFONT, reinterpret_cast<WPARAM>(titleFont), TRUE);
        Child(L"STATIC", L"A horizontal flip that your call receives, too.", 0, 25, 54, 480, 22);
        Child(L"STATIC", L"SOURCE CAMERA", 0, 25, 86, 320, 22);
        cameraBox = Child(WC_COMBOBOXW, L"", CBS_DROPDOWNLIST | WS_VSCROLL | WS_TABSTOP, 24, 111, 374, 240, ID_CAMERA);
        refreshButton = Child(L"BUTTON", L"Refresh", WS_TABSTOP, 409, 110, 91, 29, ID_REFRESH);
        previewWindow = Child(L"MirrorCall.CameraFlip.Preview", L"", WS_CLIPSIBLINGS, 24, 153, 476, 240);
        mirrorBox = Child(L"BUTTON", L"Flip horizontally for other people", BS_AUTOCHECKBOX | WS_TABSTOP, 24, 408, 315, 28, ID_MIRROR);
        SendMessageW(mirrorBox, BM_SETCHECK, BST_CHECKED, 0);
        startButton = Child(L"BUTTON", L"Start camera", BS_DEFPUSHBUTTON | WS_TABSTOP, 351, 403, 149, 39, ID_START);
        statusLabel = Child(L"STATIC", L"Ready", 0, 24, 455, 476, 38);
        Child(L"STATIC", L"In Teams, Meet, Zoom, or another calling app, select:\nOBS Virtual Camera", 0, 24, 502, 476, 43);
        Child(L"STATIC", L"Keep Camera Flip running during the call. No microphone is used.", 0, 24, 552, 476, 36);
        Child(L"BUTTON", L"OBS setup / troubleshooting", WS_TABSTOP, 24, 592, 227, 30, ID_SETUP);
        SetTimer(hwnd, 1, 1000, nullptr);
        Refresh();
        return 0;
    }
    case WM_COMMAND:
        switch (LOWORD(wparam)) {
        case ID_START: BeginControl(!started); break;
        case ID_REFRESH: Refresh(); break;
        case ID_MIRROR:
            capture->SetMirror(SendMessageW(mirrorBox, BM_GETCHECK, 0, 0) == BST_CHECKED);
            if (started && !busy) SetStatus(capture->FormatDescription() + (capture->Mirrored() ? L"\nSending flipped video to OBS Virtual Camera." : L"\nSending normal video to OBS Virtual Camera."));
            break;
        case ID_SETUP: ShellExecuteW(hwnd, L"open", L"https://obsproject.com/kb/virtual-camera-troubleshooting", nullptr, nullptr, SW_SHOWNORMAL); break;
        }
        return 0;
    case WM_CONTROL_DONE: {
        if (controller.joinable()) controller.join();
        busy = false;
        const HRESULT hr = HRESULT(lparam);
        started = bool(wparam) && SUCCEEDED(hr);
        SetWindowTextW(startButton, started ? L"Stop camera" : L"Start camera");
        EnableWindow(startButton, installed && !cameras.empty());
        EnableWindow(cameraBox, !started); EnableWindow(refreshButton, !started);
        if (FAILED(hr)) {
            const auto error = capture->LastError();
            SetStatus(L"Could not start. Check the camera or virtual-camera output.");
#ifndef CAMERA_FLIP_GUI_TEST
            if (!closing) MessageBoxW(hwnd, (error.empty() ? ErrorText(hr) : error).c_str(), L"Camera Flip", MB_OK | MB_ICONWARNING);
#endif
        } else SetStatus(started ? capture->FormatDescription() + (capture->Mirrored() ? L"\nSending flipped video to OBS Virtual Camera." : L"\nSending normal video to OBS Virtual Camera.") : L"Stopped. The webcam has been released.");
        if (previewWindow) InvalidateRect(previewWindow, nullptr, FALSE);
        if (closing) { if (started) BeginControl(false); else DestroyWindow(hwnd); }
        return 0;
    }
    case WM_CAPTURE_FRAME: if (previewWindow) InvalidateRect(previewWindow, nullptr, FALSE); return 0;
    case WM_CAPTURE_ERROR:
        if (!busy && started) {
            const auto error = capture->LastError(); BeginControl(false);
#ifndef CAMERA_FLIP_GUI_TEST
            if (!closing) MessageBoxW(hwnd, error.c_str(), L"Camera stopped", MB_OK | MB_ICONWARNING);
#endif
        }
        return 0;
    case WM_TIMER:
        if (started && !busy && !capture->Running()) { PostMessageW(hwnd, WM_CAPTURE_ERROR, 0, 0); return 0; }
        if (started && !busy && capture->Frames() == 0) SetStatus(L"Waiting for camera frames. Check its privacy shutter and permissions.");
        return 0;
    case WM_POWERBROADCAST:
        if (wparam == PBT_APMSUSPEND && started && !busy) BeginControl(false);
        return TRUE;
    case WM_DPICHANGED: {
        // Keep the utility's controls at a consistent scale. Reopening it adopts
        // another monitor's DPI; accepting the suggested rect avoids clipping.
        const auto* rect = reinterpret_cast<RECT*>(lparam);
        SetWindowPos(hwnd, nullptr, rect->left, rect->top, rect->right - rect->left, rect->bottom - rect->top, SWP_NOZORDER | SWP_NOACTIVATE);
        return 0;
    }
    case WM_CLOSE:
        closing = true;
        if (busy) return 0;
        if (started) BeginControl(false); else DestroyWindow(hwnd);
        return 0;
    case WM_DESTROY:
        KillTimer(hwnd, 1); DeleteObject(font); DeleteObject(titleFont); PostQuitMessage(0); return 0;
    }
    return DefWindowProcW(hwnd, message, wparam, lparam);
}
} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show) {
    HANDLE single = CreateMutexW(nullptr, TRUE, MUTEX_NAME);
    if (!single) {
        MessageBoxW(nullptr, L"Windows could not create the application session.", L"Camera Flip", MB_OK | MB_ICONERROR);
        return 1;
    }
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        if (HWND existing = FindWindowW(CLASS_NAME, nullptr)) { ShowWindow(existing, SW_RESTORE); SetForegroundWindow(existing); }
        if (single) CloseHandle(single); return 0;
    }
    if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return 1;
    if (FAILED(MFStartup(MF_VERSION))) { CoUninitialize(); return 1; }
    capture.Attach(new Capture());
    INITCOMMONCONTROLSEX controls = {sizeof(controls), ICC_STANDARD_CLASSES}; InitCommonControlsEx(&controls);
    WNDCLASSW cls = {}; cls.hInstance = instance; cls.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    cls.hIcon = LoadIconW(nullptr, IDI_APPLICATION); cls.hbrBackground = nullptr;
    cls.lpfnWndProc = PreviewProc; cls.lpszClassName = L"MirrorCall.CameraFlip.Preview"; RegisterClassW(&cls);
    cls.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    cls.lpfnWndProc = WindowProc; cls.lpszClassName = CLASS_NAME; RegisterClassW(&cls);
    dpi = int(GetDpiForSystem());
    RECT outer = {0, 0, S(524), S(638)};
    constexpr DWORD style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_CLIPCHILDREN;
    AdjustWindowRectExForDpi(&outer, style, FALSE, 0, dpi);
    HWND main = CreateWindowExW(0, CLASS_NAME, L"Camera Flip " CAMERA_FLIP_VERSION, style, CW_USEDEFAULT, CW_USEDEFAULT,
        outer.right - outer.left, outer.bottom - outer.top, nullptr, nullptr, instance, nullptr);
    if (main) {
        ShowWindow(main, show); UpdateWindow(main);
        MSG msg;
        while (GetMessageW(&msg, nullptr, 0, 0) > 0) { if (!IsDialogMessageW(main, &msg)) { TranslateMessage(&msg); DispatchMessageW(&msg); } }
    }
    if (controller.joinable()) controller.join();
    capture->Stop(); capture.Reset();
    MFShutdown(); CoUninitialize();
    if (single) CloseHandle(single);
    return main ? 0 : 1;
}
