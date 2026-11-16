#pragma once
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <vector>
#include <limits>

namespace flip {
enum class PixelFormat { NV12, YUY2, BGRA };

inline size_t Nv12Size(unsigned width, unsigned height) {
    if (!width || !height || (width & 1) || (height & 1) || width > 8192 || height > 8192)
        throw std::invalid_argument("Camera needs an even-sized frame, at most 8192 pixels per side.");
    return size_t(width) * height * 3 / 2;
}

// Source rows may contain padding. 'first' always means the top displayed row;
// a negative BGRA stride is supported. Destination is tightly packed NV12.
// NV12's U,V bytes are a PAIR: mirror pairs without swapping the color channels.
inline void PackNv12(const uint8_t* first, ptrdiff_t stride, unsigned width,
                     unsigned height, PixelFormat format, bool mirror,
                     std::vector<uint8_t>& dst) {
    const size_t needed = Nv12Size(width, height);
    const size_t rowBytes = size_t(width) * (format == PixelFormat::BGRA ? 4 : format == PixelFormat::YUY2 ? 2 : 1);
    if (!first || stride == 0 || stride == std::numeric_limits<ptrdiff_t>::min() ||
        size_t(stride < 0 ? -stride : stride) < rowBytes || (format == PixelFormat::NV12 && stride < 0))
        throw std::invalid_argument("Camera returned an invalid frame stride.");
    dst.resize(needed);
    uint8_t* yPlane = dst.data();
    uint8_t* uvPlane = yPlane + size_t(width) * height;
    if (format == PixelFormat::NV12) {
        for (unsigned y = 0; y < height; ++y) {
            const auto* row = first + ptrdiff_t(y) * stride;
            auto* out = yPlane + size_t(y) * width;
            if (mirror) std::reverse_copy(row, row + width, out);
            else std::memcpy(out, row, width);
        }
        const auto* uv = first + ptrdiff_t(height) * stride;
        for (unsigned y = 0; y < height / 2; ++y) {
            const auto* row = uv + ptrdiff_t(y) * stride;
            auto* out = uvPlane + size_t(y) * width;
            if (!mirror) std::memcpy(out, row, width);
            else for (unsigned x = 0; x < width; x += 2) {
                out[x] = row[width - 2 - x]; out[x + 1] = row[width - 1 - x];
            }
        }
        return;
    }
    if (format == PixelFormat::YUY2) {
        for (unsigned y = 0; y < height; ++y) {
            const auto* row = first + ptrdiff_t(y) * stride;
            auto* out = yPlane + size_t(y) * width;
            for (unsigned x = 0; x < width; ++x) {
                const unsigned sx = mirror ? width - 1 - x : x;
                out[x] = row[sx * 2];
            }
        }
        for (unsigned y = 0; y < height; y += 2) {
            const auto* a = first + ptrdiff_t(y) * stride;
            const auto* b = a + stride;
            auto* out = uvPlane + size_t(y / 2) * width;
            for (unsigned x = 0; x < width; x += 2) {
                const unsigned sx = mirror ? width - 2 - x : x;
                out[x] = uint8_t((unsigned(a[sx * 2 + 1]) + b[sx * 2 + 1] + 1) / 2);
                out[x + 1] = uint8_t((unsigned(a[sx * 2 + 3]) + b[sx * 2 + 3] + 1) / 2);
            }
        }
        return;
    }
    // Uncommon RGB-only cameras: BT.601 limited-range conversion, subsampling
    // each 2x2 block once. Normal NV12 cameras never enter this conversion path.
    auto clamp = [](int value) { return uint8_t(std::clamp(value, 0, 255)); };
    for (unsigned y = 0; y < height; y += 2) {
        for (unsigned x = 0; x < width; x += 2) {
            int red = 0, green = 0, blue = 0;
            for (unsigned dy = 0; dy < 2; ++dy) for (unsigned dx = 0; dx < 2; ++dx) {
                const unsigned sx = mirror ? width - 1 - x - dx : x + dx;
                const auto* px = first + ptrdiff_t(y + dy) * stride + sx * 4;
                blue += px[0]; green += px[1]; red += px[2];
                yPlane[size_t(y + dy) * width + x + dx] = clamp(((66 * px[2] + 129 * px[1] + 25 * px[0] + 128) >> 8) + 16);
            }
            red = (red + 2) / 4; green = (green + 2) / 4; blue = (blue + 2) / 4;
            auto* out = uvPlane + size_t(y / 2) * width + x;
            out[0] = clamp(((-38 * red - 74 * green + 112 * blue + 128) >> 8) + 128);
            out[1] = clamp(((112 * red - 94 * green - 18 * blue + 128) >> 8) + 128);
        }
    }
}

inline void MakePattern(unsigned width, unsigned height, std::vector<uint8_t>& frame) {
    frame.resize(Nv12Size(width, height));
    for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < width; ++x)
        frame[size_t(y) * width + x] = x < width / 2 ? 81 : 41;
    auto* uv = frame.data() + size_t(width) * height;
    for (unsigned y = 0; y < height / 2; ++y) for (unsigned x = 0; x < width; x += 2) {
        uv[size_t(y) * width + x] = x < width / 2 ? 90 : 240;
        uv[size_t(y) * width + x + 1] = x < width / 2 ? 240 : 110;
    }
}

inline void MakePreview(const std::vector<uint8_t>& nv12, unsigned width, unsigned height,
                        std::vector<uint32_t>& pixels, unsigned outW, unsigned outH, bool bt709) {
    pixels.resize(size_t(outW) * outH);
    const auto* uv = nv12.data() + size_t(width) * height;
    for (unsigned y = 0; y < outH; ++y) for (unsigned x = 0; x < outW; ++x) {
        const unsigned sx = unsigned(uint64_t(x) * width / outW);
        const unsigned sy = unsigned(uint64_t(y) * height / outH);
        const int c = int(nv12[size_t(sy) * width + sx]) - 16;
        const int u = int(uv[size_t(sy / 2) * width + (sx & ~1U)]) - 128;
        const int v = int(uv[size_t(sy / 2) * width + (sx & ~1U) + 1]) - 128;
        const int red = (298 * c + (bt709 ? 459 : 409) * v + 128) >> 8;
        const int green = (298 * c - (bt709 ? 55 : 100) * u - (bt709 ? 136 : 208) * v + 128) >> 8;
        const int blue = (298 * c + (bt709 ? 541 : 516) * u + 128) >> 8;
        pixels[size_t(y) * outW + x] = 0xFF000000U | (uint32_t(std::clamp(red, 0, 255)) << 16)
            | (uint32_t(std::clamp(green, 0, 255)) << 8) | uint32_t(std::clamp(blue, 0, 255));
    }
}
} // namespace flip
