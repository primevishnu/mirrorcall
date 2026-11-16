#pragma once
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <algorithm>
#include <cstdint>
#include <vector>

namespace flip {
// Persistent off-screen surface. Compose never touches the visible window;
// Present makes exactly one finished-image copy. In particular, the background
// clear cannot become an intermediate black frame on the screen.
class PreviewSurface final {
public:
    PreviewSurface() = default;
    PreviewSurface(const PreviewSurface&) = delete;
    PreviewSurface& operator=(const PreviewSurface&) = delete;
    ~PreviewSurface() { Reset(); }

    bool Ensure(HDC reference, int width, int height) {
        if (width <= 0 || height <= 0) return false;
        if (dc_ && width == width_ && height == height_) return true;
        HDC nextDc = CreateCompatibleDC(reference);
        HBITMAP nextBitmap = CreateCompatibleBitmap(reference, width, height);
        if (!nextDc || !nextBitmap) {
            if (nextDc) DeleteDC(nextDc);
            if (nextBitmap) DeleteObject(nextBitmap);
            return false;
        }
        HGDIOBJ previous = SelectObject(nextDc, nextBitmap);
        if (!previous || previous == HGDI_ERROR) { DeleteObject(nextBitmap); DeleteDC(nextDc); return false; }
        Reset(); dc_ = nextDc; bitmap_ = nextBitmap; previous_ = previous;
        width_ = width; height_ = height;
        return true;
    }

    void Compose(const std::vector<uint32_t>& pixels, unsigned width, unsigned height, HFONT font) {
        if (!dc_) return;
        RECT rect = {0, 0, width_, height_};
        SetDCBrushColor(dc_, RGB(22, 24, 32));
        FillRect(dc_, &rect, static_cast<HBRUSH>(GetStockObject(DC_BRUSH)));
        if (width && height && pixels.size() >= size_t(width) * height) {
            const double scale = std::min(double(width_) / width, double(height_) / height);
            const int w = std::max(1, int(width * scale));
            const int h = std::max(1, int(height * scale));
            BITMAPINFO info = {}; info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
            info.bmiHeader.biWidth = LONG(width); info.bmiHeader.biHeight = -LONG(height);
            info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
            SetStretchBltMode(dc_, HALFTONE);
            SetBrushOrgEx(dc_, 0, 0, nullptr);
            StretchDIBits(dc_, (width_ - w) / 2, (height_ - h) / 2, w, h,
                0, 0, width, height, pixels.data(), &info, DIB_RGB_COLORS, SRCCOPY);
        } else {
            SetBkMode(dc_, TRANSPARENT); SetTextColor(dc_, RGB(190, 191, 204));
            const auto oldFont = SelectObject(dc_, font);
            DrawTextW(dc_, L"Camera is stopped", -1, &rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
            SelectObject(dc_, oldFont);
        }
    }

    void Present(HDC target) const {
        if (dc_) BitBlt(target, 0, 0, width_, height_, dc_, 0, 0, SRCCOPY);
    }

private:
    void Reset() {
        if (dc_) {
            SelectObject(dc_, previous_); DeleteObject(bitmap_); DeleteDC(dc_);
        }
        dc_ = nullptr; bitmap_ = nullptr; previous_ = nullptr; width_ = height_ = 0;
    }
    HDC dc_ = nullptr;
    HBITMAP bitmap_ = nullptr;
    HGDIOBJ previous_ = nullptr;
    int width_ = 0, height_ = 0;
};
} // namespace flip
