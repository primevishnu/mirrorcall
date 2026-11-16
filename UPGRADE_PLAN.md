# MirrorCall: stability-first upgrade plan

Prepared 7 November 2026. The user reports good FPS and image quality, with an intermittent
in-app video-size blip. This is a qualitative report, not a measured performance baseline.
The recommended order is to stabilize display behavior, then add small usability features.
Status: core upgrades A-F are implemented in 2.1.0. Later/experimental features remain deferred. See AUDIT.md for validation limits.

## 1. Preserve what is working

Keep the native Camera2 capture path, frame-rate range selection, texture-based media path,
H.264/VP8 ordering, bitrate limits, MAINTAIN_FRAMERATE adaptation, audio processing and
WebRTC version unchanged during usability work. Keep the manual code format and current
copy/share behavior: code only, no extra introduction. Do not replace the calling engine.

This does not mean freezing dependencies forever: security/compatibility updates should
be separate, tested releases. No new feature can be promised to have literally zero impact;
the plan minimizes ongoing work and requires comparisons before release.

Reviewed implementation: web/app.mjs, web/engine.mjs, crypto/code handling, native renderer
and camera capturer, MainActivity permissions/audio/PiP, CallService, manifest, build metadata,
prior audit and call tests. This is an engineering review, not an independent security audit.
The separate Windows app is outside this plan.

## 2. Current video-size blip: evidence and limits

User clarification: only the video within MirrorCall changes size, not the whole activity
entering a floating window; it can occur without a tap as well as around interaction.
No physical Android device is currently connected through adb. No trace of the user's
actual incident is available. Therefore a phone-specific root cause is not confirmed.

Confirmed in the source before this change:

- NativeEngine.onFrameResolutionChanged calls placeBottom when incoming dimensions change.
- placeBottom changes between full-area fill and aspect-fit at a hard 20% shape threshold.
  This is a real discontinuity: a small aspect change near that threshold can cause a much
  larger change in displayed size. Ordinary resolution scaling at the SAME aspect ratio
  does not by itself cross the threshold. Do not claim otherwise.
- place calls setLayoutParams even if the requested bounds are identical.
- setEnableHardwareScaler(true) allows WebRTC to change the underlying surface size as
  frame dimensions change. Upstream notes possible device-specific bugs with that option.
  This is a second hypothesis, not evidence that it fails on this iQOO.
- Two taps within 350 ms on the same large/small video role trigger swapping. Previously,
  the taps did not have to be near the same position, so two unrelated taps could qualify.
- Hiding controls changes opacity/visibility only; it does not change the video element's
  width/height or enter PiP. PiP and explicit swaps have separate diagnostic events.

The layout arithmetic was reproduced off-device, including a control case where two
resolutions with the same aspect produce the same bounds. This proves the threshold
behavior, not that it caused the user's actual incident.

Current scoped work (2.0.2): single-tap toggling plus a consistent aspect-fit policy for the
large call image, with redundant layout updates skipped. The entire image remains visible;
black bars are possible when video and screen shapes differ. Home/tile filling is retained.
Double taps must also be close in position; dragging is distinguished from tapping.
Camera, encoder, bitrate, capture FPS and hardware-scaler configuration are not changed.

If the blip persists, the next investigation should correlate an incident with frame size,
rotation, requested bounds and actual surface-size changes in a temporary diagnostic build.
Log changes only, with bounded in-memory storage; do not log every frame or video pixels.
Compare scaler enabled/disabled in separate test builds on the same phone and lighting,
measuring GPU/CPU/frame pacing before choosing a fallback. Do not blindly disable it for
all devices. If bounds are stable while the surface blips, focus on the surface/device path;
if bounds move, focus on layout/orientation. Also inspect swap/PiP timestamps.

Sources: [WebRTC SurfaceViewRenderer](https://webrtc.googlesource.com/src/+/refs/heads/main/sdk/android/api/org/webrtc/SurfaceViewRenderer.java)
explains hardware scaling and surface resizing; [Android PiP guidance](https://developer.android.com/develop/ui/views/picture-in-picture)
separates whole-activity PiP transitions from in-app layout.

## 3. First upgrade batch: small interface changes

### A. Control visibility preferences

Add a setting for 4 seconds (current default), a longer timeout, or always visible. Retain
single-tap hide/show and double-tap swap. Keep controls available while dialogs are open,
while connecting, and when connection recovery needs attention. Honor accessibility timeout
preferences on supported Android versions and offer an explicit always-visible option.

Implementation: web/app.mjs and styles; a small native bridge only for Android accessibility
preferences. Event-driven timers only. No render loop, camera restart, new library or server.
Check screen-reader navigation, keyboard, large text, hidden-button hit testing, drag and swap.
Android provides [getRecommendedTimeoutMillis](https://developer.android.com/reference/android/view/accessibility/AccessibilityManager#getRecommendedTimeoutMillis(int,%20int))
for UI timeouts on API 29+, with an older-version fallback required.

### B. Join directly from Android's Share menu

Allow sharing a copied MC1 message into MirrorCall from an app that supports text sharing.
Prefill the offer/reply field and validate which call it belongs to. Keep explicit confirmation
before starting camera/microphone for a new call. Reject oversized, malformed and unrelated
payloads using existing validation. Never replace an active call silently.

Implementation: ACTION_SEND/text/plain support in the manifest and MainActivity, routed to
the existing code parser/UI. Processing happens only on receipt, outside steady-state media.
No hosting, contact permission, QR scanner or new runtime dependency. Support depends on
whether the source app actually exposes text sharing; Copy/Paste remains available.
See [Android receiving shared data](https://developer.android.com/training/sharing/receive).

### C. Before-call microphone and camera choices

Expose start-muted / camera-off choices before connecting, including front/rear selection.
Reuse existing mic/camera controls and transceivers rather than adding a second preview or
capture session. Preserve the current defaults unless the user changes them. Do not start
microphone capture merely because the home screen is open.

Check caller and answerer paths, permission denial, video initially off then enabled,
returning from WhatsApp, and a second call. No new processing is needed during normal video.

Recommended first release: A and B only, separately switchable. C is the next small release
because it touches media startup, even though it adds no ongoing processing.

## 4. Second batch: useful Android integration

### D. Explicit audio-output picker

Show the actual available choices (speaker, phone earpiece, connected headset), and display
which route Android actually accepted. Current code already uses setCommunicationDevice
on API 31+ and device callbacks, but exposes mainly Speaker versus Phone/headset.
Keep existing echo cancellation and microphone processing unchanged. Update the UI from
route-change callbacks, not polling. Retain a tested older-Android fallback.

This is low expected video overhead but medium audio-compatibility risk. Test Bluetooth
Classic, BLE where available, USB/wired headsets, disconnect/reconnect, alarms and phone
call interruptions. A request to choose a device is not proof that the route changed.
See [Android's AudioManager calling guide](https://developer.android.com/develop/connectivity/bluetooth/ble-audio/audio-manager).

### E. Mute and Leave in the ongoing-call notification

The notification currently opens the app; PiP already has mute/leave actions. Reuse the
existing action handling to provide notification controls, with notification state updated
only when the call or mic state changes. Use platform CallStyle on supported versions and
a compatible normal notification otherwise. Do not introduce background polling or a
second call engine. This improves an existing active call; it does not add incoming ringing.

Verify actions with the screen locked, app hidden, PiP visible, denied notification
permission and after call teardown. Keep action intents scoped to this app.
Android's [CallStyle](https://developer.android.com/develop/ui/views/notifications/call-style)
supports ongoing-call notifications with a hang-up action from API 31.

### F. Clearer call-health information

Improve the existing details sheet and optional local post-call summary, using statistics
already collected. Show unavailable fields as unknown, not zero. Distinguish CPU/encoder,
network loss and camera limits rather than presenting an invented quality score.

Do not add an always-on graph or increase routine stats polling. Keep the existing sparse
background sample cadence; use detailed sampling only while the sheet is open or in an
explicit diagnostic session. Bound stored samples. Exclude call codes, SDP, credentials,
addresses and chat contents from exports; review IPv6 redaction as well as IPv4.

## 5. Later, only after stability is demonstrated

- PiP automatic/manual preference: useful, with little ongoing work, but test Android
  lifecycle and OriginOS transitions separately. The reported in-app blip is not evidence
  that auto-PiP caused it.
- Hide or reposition self-preview: change only the local display sink; never stop sending
  video when hiding your own tile. Native surface lifecycle makes this a separate test item.
- True immersive mode hiding Android status/navigation bars: optional and deferred until
  the current size blip is resolved. Insets change the available viewport and can create
  fresh resize transitions. Use Android's [system-bar APIs](https://developer.android.com/develop/ui/views/layout/immersive),
  preserve cutout/keyboard handling, and provide a reliable exit gesture.
- QR invitations: setup-only, but MC1 codes are variable length and can exceed a practical
  single QR payload. Do not promise every full SDP fits. A scanner also needs careful
  camera ownership before a call and should not assume Google Play Services on every phone.
  Prefer Share-menu import first.
- Short invitations or incoming ringing: needs online signaling/notification infrastructure
  and additional lifecycle work. Existing hosted mode already supplies signaling; this
  would make it easier to use, not eliminate its hosting requirement. Keep optional and
  leave current manual code mode working. Do not fold it into the first upgrade batch.

TURN remains optional where a direct route works. No upgrade plan promises every network
without a relay: [WebRTC's TURN documentation](https://webrtc.org/getting-started/turn-server)
explains why some networks need one. No server or paid service is planned for the first batch.

## 6. Defer features that can disturb present quality

Do not bundle background blur/replacement, beauty filters, face tracking, AI enhancement,
recording, live transcription, 4K/60 fps modes, new default codecs, extra camera streams,
or large animated overlays into these releases. They add compute, bandwidth, surface or
storage work and need their own opt-in experiments. Avoid changing multiple video-engine
settings at once, and avoid broad refactoring solely to make the source shorter.

## 7. Release gates that protect current performance

1. Keep the signed 2.0.1 baseline and its source snapshot. APK SHA-256:
   704f988dc63be752442d1bed0e2a4188bc99bd9a0b8c82b833c969f941549d8a.
   Keep the signing key private. A normal Android update cannot simply be rolled back by
   installing a lower version code; revert source and issue a higher-code signed build.
2. Establish measurements on BOTH real phones: same network, lighting, camera, quality,
   screen brightness and similar starting temperature. Use repeated baseline/candidate
   calls with a warm-up, a stationary scene and controlled motion. Include a longer call
   to observe heat-related degradation. The existing emulator proves behavior, not FPS.
3. Compare send/receive FPS distributions, delivered resolution/bitrate, freezes/stalls,
   encode time, audio continuity, CPU/memory and temperature under matched conditions.
   Do not use only average FPS or a UI screenshot as a smoothness benchmark. Record normal
   variability first; reject a repeatable regression beyond it rather than inventing a
   universal percentage budget without device data.
4. Test features disabled AND enabled. Idle features should introduce no new periodic work
   or media-path allocation. New event handlers must release resources on hang-up. Never
   hide a performance loss by lowering quality without the user's choice.
5. Run affected browser/native tests and real-phone acceptance checks for caller/answerer,
   rejoin, mirror, camera switch, rotation, controls, PiP, background/resume and hang-up.
   Add focused tests for each changed behavior rather than repeating unrelated checks.
6. Use short, opt-in [Android system traces](https://developer.android.com/topic/performance/tracing)
   when a regression appears. Do not ship continuous tracing or per-frame disk logging.
7. Ship one small batch at a time with the same signing identity and an incremented version
   code. Keep experimental display/audio options off by default until verified. The user
   must get both good video and correct controls before new features are stacked on top.

Suggested order: current tap/display fix -> measure baseline -> control preferences and
Share import -> pre-call choices -> audio picker/notification controls -> optional extras.
