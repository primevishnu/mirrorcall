# Camera Flip for Windows

A small native Windows app that flips your webcam horizontally **before calling apps
receive it**. It has a source-camera picker, Start/Stop, and a flip checkbox. It does not
capture audio, record video, or send anything to a server.

## Use it

1. Close any older running copy, then open **CameraFlip-1.0.1.exe** in this folder.
   `CameraFlip.exe` is also updated when the build can replace it safely.
2. Select your webcam and click **Start camera**.
3. In your calling app, select **OBS Virtual Camera** as the camera:
   - **Teams:** Settings → Devices → Camera.
   - **Google Meet:** Settings → Video → Camera.
   - **Zoom:** Settings → Video → Camera, or the arrow beside the video button in a meeting.
4. Leave **Flip horizontally for other people** checked. Uncheck it for normal video.
   The change is live; you do not need to restart the call.
5. Keep Camera Flip open or minimized during your call. Click **Stop camera**, or close
   the app, to release your webcam and stop this virtual-camera output.

Your microphone and speaker stay selected in the calling app. Its own "mirror my video"
setting may mirror your local self-view again; verify the result with the other person's
view or hold up text in this app's preview. The image published by Camera Flip is flipped
regardless of a calling app's self-view setting.

## One dependency: the installed OBS virtual camera

This app uses the virtual-camera component included with [OBS Studio](https://obsproject.com/).
**OBS is already installed and its virtual camera is registered on the PC used to build
this app.** OBS's interface does not need to be running. Do not start virtual-camera
output inside OBS while Camera Flip is publishing; there can be only one publisher.

On another PC, install OBS Studio once if **OBS Virtual Camera** is missing. Camera Flip
does not bundle, install, rename, or re-register OBS's components. It does not alter your
existing OBS scenes or settings. If necessary, use OBS's official
[virtual-camera troubleshooting instructions](https://obsproject.com/kb/virtual-camera-troubleshooting).

The app is Windows x64, intended for Windows 10/11. It is a standalone executable with
the C++ runtime linked in; you do not need Python, .NET, or a running web server to use it.
The executable is not Authenticode-signed. Keep Windows security checks enabled and use
your own build or the file from this project.

## What it can change

The app changes the video delivered through **OBS Virtual Camera**. Select that camera
once in each app you use. It does not force Teams, Meet, Zoom, or other programs to change
their saved camera selections, and it does not modify the physical camera's firmware.
Programs or work policies that disallow virtual cameras may not accept this output.

Native camera formats are preferred up to 1920×1080 at 30 fps. The actual format depends
on your webcam. NV12 frames are flipped by reversing luma rows and chroma pairs, without
an encoding step. YUY2/RGB-only sources are converted to NV12 for the OBS interface;
the calling app applies its own encoding and resolution settings afterward. The small
preview uses a persistent off-screen drawing surface and updates at up to 30 fps.
Only one preview notification can be pending, and preview processing pauses when the
window is minimized. The preview stays within 384×216 pixels before display scaling.

Camera negotiation tries alternate native modes if a preferred mode cannot be converted.
Additional UYVY, planar YUV, RGB24 and H.264 source modes can use Windows' available
converters. Actual support still depends on the camera and installed Windows codecs.

## Troubleshooting

- **Camera busy:** close apps using the physical webcam, then start Camera Flip. Your
  calling app should use OBS Virtual Camera rather than opening the physical source too.
- **Virtual camera busy:** stop OBS's virtual-camera output and other publishers. After
  stopping another publisher, allow the calling app a moment to release the old stream.
- **Black camera:** check the physical privacy shutter and Windows Settings → Privacy &
  security → Camera → allow camera access and desktop apps. Refresh the camera list.
- **Virtual camera missing from an app:** fully quit and reopen that calling app/browser
  after installing OBS. Confirm its camera permissions and select OBS Virtual Camera.
- **Sleep/unplug:** capture stops when Windows suspends or the source fails. Restart
  capture after reconnecting the camera or resuming Windows.
- **Camera formats:** unusual formats, interlaced cameras, and vendor-specific camera
  software may need additional testing. This utility does not apply effects or filters.

## Source, license, and build

This Windows app and its OBS transport source are distributed under **GPL-2.0-or-later**.
The complete license is in `vendor/obs/COPYING`; attribution is in `vendor/obs/NOTICE.md`.
Keep the source, license, and build instructions available when redistributing the app.

Build with Visual Studio 2022 C++ Build Tools (MSVC x64) and a Windows 10/11 SDK:

```powershell
python windows/build.py
```

This builds `windows/CameraFlip-1.0.1.exe`, runs native frame-processing and preview tests, and checks the
registered virtual camera. It does not open your physical webcam during the build.
The release version is read from `VERSION`. The generic `CameraFlip.exe` copy is refreshed
if it is not locked by a running process; the versioned executable is always the new build.

Additional checks, from the project root:

```powershell
# Actual virtual camera → Chromium → WebRTC receiving video; synthetic colors only:
node windows/tests/virtual-camera.mjs

# Briefly open the physical camera and report frame counts; no image is saved:
windows/build/CameraFlipTests.exe --camera-check

# Restart/cleanup checks, including an old callback arriving after a restart:
windows/build/CameraFlipTests.exe --lifecycle

# Physical camera restart check; captures briefly, without saving images:
windows/build/CameraFlipTests.exe --camera-restart-check

# Start/stop an isolated test build in a hidden window; synthetic frames only:
python windows/tests/gui-smoke.py
```

The Chromium integration test needs the root project's Playwright development dependency
and installed Chromium browser. Those are only test tools, not app runtime dependencies.
See [VALIDATION.md](VALIDATION.md) for the checks completed on the build machine.

## Research references

- Microsoft: [Media Foundation Source Reader](https://learn.microsoft.com/en-us/windows/win32/medfound/processing-media-data-with-the-source-reader).
- Microsoft: [Windows 11's separate virtual-camera API](https://learn.microsoft.com/en-us/windows/win32/api/mfvirtualcamera/nf-mfvirtualcamera-mfcreatevirtualcamera).
- OBS: [Virtual Camera Guide](https://obsproject.com/kb/virtual-camera-guide).
- OBS: [Windows virtual-camera protocol source, pinned to 32.0.1](https://github.com/obsproject/obs-studio/tree/32.0.1/plugins/win-dshow).

Windows 11 also offers a native virtual-camera API, but it requires a registered custom
media-source implementation. Reusing the already-installed OBS endpoint keeps this app
small and avoids installing another virtual-camera component.

The preview renderer follows Microsoft's [off-screen memory-DC drawing pattern](https://learn.microsoft.com/en-us/windows/win32/gdi/memory-device-contexts).
The main window uses [child-window clipping](https://learn.microsoft.com/en-us/windows/win32/winmsg/window-styles)
to keep parent background repaints out of the video surface.
