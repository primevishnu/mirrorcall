# MirrorCall 2.0.0 verification

Audit date: 7 November 2026. Scope: unfinished Android native-engine rebuild, code-mode
connection failures, video lifecycle/rendering, view swapping and picture-in-picture.
The Windows Camera Flip application was not changed.

## Fixed

- Initial connection failure/timeout no longer calls `leaveCall` or discards the setup code.
  The call screen keeps an explanation and can accept a later connected state.
- Under load, the previous six-second gathering cutoff could export SDP with **zero ICE
  candidates**. Native gathering now requires at least one usable address, permits a bounded
  extra wait for cold network discovery, and returns an error instead of an unusable code.
  Both engines' shared code-generation path also rejects address-free descriptions.
- Native SDP callbacks and camera events cannot operate on an old peer/capture session after
  hang-up. Cancelled camera startup answers its pending request rather than leaving the UI busy.
- Native ICE gathering polls asynchronously instead of blocking media/lifecycle commands.
  Direct mode gathers for the code; hosted mode can gather additional routes continuously.
- Video swapping records tile dimensions before CSS expands the local view. Empty HTML
  video posters are hidden over the native renderers. Remote video is fitted when its shape
  differs substantially from the screen.
- Native data-channel send results are checked before reporting a chat message as sent.
- Relay-only code mode refuses to start without TURN settings. No implicit direct fallback.
- Native renderers and shared EGL resources are released after media stops.
- Updated version/dependency metadata, bundled upstream notices, install and hosting docs.

## Verification

- Node unit tests: 14 passed (signaling, admission, replay/encryption and code format).
- Browser integration: 5 passed. Real WebRTC pixels, both code/server modes, camera recovery,
  mute/chat, reconnect/rejoin, code-only clipboard, view swap dimensions, a simulated ICE
  failure staying on screen, relay-only refusal and offline license asset loading.
- Android 16 x86_64 emulator: the real native engine was tested against desktop Chromium in
  both caller and answerer roles. Checks include native received pixels with mirror on/off,
  outgoing video, repeated calls, native camera release/reopen/switch, background/resume,
  chat, PiP entry/exit and hang-up in both directions. Final candidate-wait regression and hang-up-during-setup run passed and is recorded in `build/native-call-results.txt`.
- The test APK adds x86_64 and enables debugging; the distributed APK includes only ARM64
  and ARMv7, with debugging disabled. Both use the same source and signing key.
- Release verification checks bundled assets against `web/`, APK v2/v3 signatures, package
  version 2.0.0 / code 8, API 26 minimum / API 36 target and native library ABIs.
- ARM64 ELF load segments are 16 KiB aligned; ZIP alignment is checked as well.
- Android camera service reported no active camera clients after the final setup cancellation.

The native test asserts that the decompressed setup offer contains a host candidate. A
prior run exposed a code with no candidates under concurrent build/browser-test load;
the release was held back and the bounded candidate wait was fixed. This is not proof that
it was the only cause of the user's earlier phone-to-phone failures.

## Still requires the two actual phones

The emulator uses software encoding/rendering and is **not a phone performance benchmark**.
No physical phone is attached through adb. Unverified: sustained camera FPS/clarity and
hardware H.264 on the iQOO and partner device, thermal behavior, Bluetooth/earpiece audio,
OriginOS background restrictions, separate-carrier NAT traversal, and real TURN deployment.
Follow `PHONE_TEST_CHECKLIST.md`. A usable network route is still required; native capture
and the code exchange cannot guarantee connectivity or 30 fps on every network/device.

No server or relay was deployed. No independent security audit was performed.

## Release artifact

`dist/MirrorCall-2.0.0.apk` ? 10,368,436 bytes.

SHA-256: `6701fc6f0cab216337af4ee7d8f05a365f9b4dcfdbd9c433f46e76be5afd1d36`

Signing certificate SHA-256:
`0f53aa845984dd55045f283c264d67607cf771a199905685dad78811e5ff8979`

## 2.0.1: unobstructed call view

The controls, labels and dark overlay fade after four seconds of inactivity during a
connected call. Pointer or keyboard interaction reveals controls and resets the timer.
Open dialogs and setup/recovery states keep controls visible. Video elements and native
surfaces remain attached at the same size; media capture and encoding were not changed.
Status toasts no longer intercept taps on call controls.

Validation: the five browser scenarios passed across the initial run and targeted rerun.
The initial server-call timeout identified a toast covering hang-up; after the fix, both
full server-call and manual-code scenarios passed. The manual-code test verifies hiding,
both videos remaining visible, a tap at the hidden microphone button not activating it,
dialogs holding the controls open, and hiding resuming after the dialog closes. Existing
double-tap swap and call lifecycle checks also pass. Android assets and signatures match
the signed release; no new physical-device test was performed for this UI change.

Release: `dist/MirrorCall-2.0.1.apk`, version code 9, same signing identity as 2.0.0.
SHA-256: `704f988dc63be752442d1bed0e2a4188bc99bd9a0b8c82b833c969f941549d8a`.

## 2.0.2: manual control toggles and display-size investigation

User report: current FPS/clarity are good, but video inside the activity occasionally
changes size, both around interaction and without touching the screen. Whole-app PiP
minimization was explicitly ruled out by the user. No physical phone trace was available.

Confirmed source findings: the large native view switched from fill to fit at a 20%
aspect-ratio threshold, and repeated layout calls set the same bounds again. Reproducing
that arithmetic shows an abrupt size step near the threshold; same-aspect resolution
changes alone do not produce that step. The observed phone-side root cause is still
unconfirmed. Hardware surface scaling is a separate possible contributor, not a diagnosis.

Changes: consistently fit the large call image; skip unchanged layout bounds. Retain
hardware-scaler configuration, camera capture, codec selection, bitrate/FPS limits and
audio processing. Some screen/video combinations now have letterboxing. Actual aspect
or orientation changes can still legitimately change the fitted image dimensions.

Single video taps now hide/show controls, with a short double-tap recognition interval
before hiding. Four-second inactivity hiding remains. Double-tap swapping also checks
spatial proximity; swiping and dragging no longer qualify as stationary video taps.

Browser validation: five call scenarios passed, including manual hide/show, hidden-button
hit testing, unchanged video element bounds, spatial double-tap handling, swap, chat,
background/resume and reconnect. Native Android integration is tracked in
`build/native-call-2.0.2-results.txt`. These tests do not reproduce the user's actual iQOO
incident or prove unchanged real-phone FPS. Follow the phone checklist to confirm it.

The researched, prioritized feature roadmap is in UPGRADE_PLAN.md. Future roadmap features
are not implemented in this release; the current changes respond to the later glitch and
tap-toggle requests.

Release 2.0.2: version code 10, same signing identity. SHA-256: `79e392c9d3a4f683b8c701c0946b5863c0f54dbcf18537bd66e81da71a7d56f8`.

Final native integration passed for 2.0.2: native caller and answerer, video/mirror pixels,
camera off/on/switch, background/resume, chat, actual PiP, repeated calls and cancellation
during setup. The first mirror check failed while sampling two different screenshots;
the test now waits for both expected colors within one captured frame, and the rerun
passed. No product mirror or encoding change was made in response to that test timing.
APK assets, signing identity, release ABI set and version were verified. The emulator's
software-codec FPS is not evidence of performance on the user's phones.

## 2.1.0 core upgrades (10 November 2026)

Implemented the six core roadmap items: 4/8-second or pinned controls with Android
accessibility support; validated ACTION_SEND code import; persistent pre-call mute,
camera-off and front/rear choices; event-driven AudioManager output selection; ongoing
notification mute/unmute/hang-up actions; honest missing metrics and an in-memory last-call
summary. No hosted service, background ringing, video filter, recording or new media
library was added. Call codes still copy/share without introductory text.

Preservation audit compared source with build/baseline-2.0.2-source.zip: camera capturer,
native factory/audio-video creation path, codec preferences, sender tuning and quality
profiles are unchanged. Early mute is now applied before creating the microphone track.
Statistics retain the existing 30-second quiet cadence / two-second open-sheet cadence;
initial samples are now cancellable on teardown. No new periodic audio-device polling.

The user reports that the in-app video-size blip persists. The earlier fill/fit correction
is not claimed as a confirmed fix. An OFF-by-default Android display-compatibility option
now disables resolution-dependent surface scaling. It can increase graphics workload and
needs an A/B test on the affected phone. When enabled it records bounded dimension-change
events in memory, with no per-frame or per-resize storage write. Existing normal log writes
may persist the buffered entries. No actual camera frames, names, addresses or call contents
are recorded by these display events.

Audit findings addressed: notification/PiP action URIs now have a matching receiver filter
scheme; actions carry per-call tokens and cannot control a later call through a stale token.
Android route selection is reported from the actual selected communication device, not
assumed from a successful request. Shared offers require explicit joining, shared answers
must match the current call, and active calls cannot be replaced by an incoming offer.
Unknown statistics remain unknown; zero RTT/FPS/bitrate is preserved when actually reported.
Diagnostics redact configured secrets, code/link content, SDP credentials, IPv4 and IPv6.

Validation: 20 Node tests and all 7 browser scenarios passed in the resumed final run.
The prior browser helper could observe visible controls just before their timeout; it now
resets the timer using a real keyboard event before control actions. Explicit touch tests
still exercise hide/show and hidden-button hit testing. Android lint results are saved in
build/lint-2.1.0-results.txt (generated CLI project, LintError/UnusedResources/DataExtractionRules
disabled as for prior builds). Native integration results are recorded separately in
build/native-call-2.1.0-results.txt. Final results below supersede earlier partial runs.

Physical-phone FPS, Bluetooth/USB devices, lock-screen notification behavior and the actual
iQOO blip require device acceptance tests. Emulator software rendering is not a phone
performance benchmark. No claim of universal bug-free behavior or universal connectivity.

Resumed verification on 10 November: all 20 unit tests and all 7 browser scenarios passed
in one final run. Release v2/v3 signatures, version code 11, ARM64/ARMv7 ABI set, absence
of the debuggable flag and byte-for-byte bundled web assets were checked. Android lint
reported zero errors; its two warnings concern version metadata omitted from the temporary
lint project, not the versioned release APK. A cold emulator launch hit an input-dispatch
ANR while the host was under memory pressure; this is recorded, not treated as a confirmed
phone defect or dismissed as proof of safety. The native test harness now waits for the
WebView debugging endpoint and cleans up when attachment fails.

FINAL NATIVE RESULT: passed. Actual notification Mute, Unmute and Hang up were operated
through the Android notification panel and verified at the peer. Audio outputs were
selected and checked against Android's reported route. ACTION_SEND offers/replies,
camera-off/muted native answering (including no active camera hardware), later enabling
media, mirror pixels, camera switching, background/resume, PiP, repeat calls, remote
hang-up, last-call details and cancellation during setup passed. First call used display
compatibility mode; second used the normal mode. Physical Bluetooth/USB and iQOO display
behavior remain unverified. No FPS improvement/regression claim is based on emulator FPS.

Release SHA-256: `f2ebbe9312e19020b0d6928e5d5dc20b28b2d66a1fbe04462f262416e1ba47e4`. Same signing certificate as prior releases.
