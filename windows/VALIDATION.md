# Validation

## Version 1.0.1 audit and preview fix

- Replaced visible background clearing and drawing with a persistent off-screen surface
  and one final presentation copy. Parent window painting now excludes child windows.
- A 1,000-frame GDI regression check confirms off-screen composition leaves the prior
  target frame intact, final presentation has the expected colors, and resize/destruction
  releases all GDI handles allocated by the test.
- Preview updates follow camera frames up to 30 fps, replacing the old 10 fps throttle.
  Pending notifications are coalesced, and preview dimensions are bounded for portrait
  and unusual aspect ratios.
- Each real camera session has its own callback and flush event. Stop invalidates its
  generation and drains active callback work before frame/session state is reused.
- Publisher lifecycle and stale-callback restart regression tests pass. The physical
  Integrated Camera also starts, captures live frames and stops over three sessions.
- Capture initialization now checks setup failures, detects a busy publisher before
  opening the physical camera, and tries alternate camera modes/conversions.
- Buffer bounds use checked offsets before pointer arithmetic; invalid signed-minimum
  strides are rejected without overflow.
- The native GUI smoke check uses a separate test-only executable and synthetic source,
  so it can run without controlling or opening the user's running application.
- Virtual-camera and WebRTC receiving-pixel tests pass, including live mirror toggling.

The following baseline checks were also completed during the initial build:

Tested on this Windows x64 machine with OBS Studio 32.0.1's registered virtual camera.
The app was compiled using MSVC 14.44 and the Windows 10.0.26100 SDK, with the C++ runtime
statically linked. Python and Playwright are development/test tools only.

Completed checks:

- Native frame tests: padded NV12 row handling, horizontal luma reversal, UV-pair order,
  exact restoration after a double flip, YUY2 chroma conversion, bottom-up RGB handling,
  invalid input rejection, and preview color ordering.
- Publisher lifecycle: reject a second publisher without altering the first, signal stop
  to consumers, release the mapping, and restart cleanly.
- Real camera: Integrated Camera delivered **84 frames in 3 seconds** at
  **1920 × 1080, 30 fps, NV12**. No images, video, or audio were saved.
- Native GUI smoke test: the hidden main window initializes without starting capture;
  Start opens the camera, Stop releases it, and closing exits cleanly.
- Virtual-camera integration: a synthetic red/blue pattern passes through the registered
  OBS Virtual Camera and is read by Chromium. Flipping produces blue on the left and red
  on the right; turning the flip off restores the original order.
- WebRTC receiving test: a second peer receives the same live flip changes. This checks
  actual received pixels, independent of any preview CSS or a meeting app's self-view.

The synthetic tests do not open the physical webcam. The real-camera and GUI checks do
open it briefly; only format information and frame counts are reported.

Limits: no signed-in Teams, Google Meet, or Zoom meeting was placed. The tested integration
is the virtual-camera/WebRTC path these applications can use when they accept the camera.
Their own policies, permissions, local self-view mirroring, and output quality settings
still apply. Virtual-camera compatibility is not guaranteed for every application/version.
