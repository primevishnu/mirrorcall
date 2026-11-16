# MirrorCall

[![Latest Release](https://img.shields.io/github/v/release/primevishnu/mirrorcall?label=Release&color=blue)](https://github.com/primevishnu/mirrorcall/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Android%208.0%2B%20%7C%20Windows-brightgreen.svg)](#install-and-call)
[![WebRTC](https://img.shields.io/badge/WebRTC-Native%20libwebrtc-orange.svg)](#whats-changed-in-20)

> **Private, peer-to-peer two-person Android video calls with on-the-fly camera flip / mirroring.**  
> Both people use MirrorCall. No account, no phone number, no root needed. It does not alter WhatsApp, Teams, Meet, or other apps' cameras. Includes a separate Windows utility in `windows/`.

📦 **[Download Latest APK (MirrorCall-2.1.0.apk)](https://github.com/primevishnu/mirrorcall/releases/latest)**


## New in 2.1.0

- **Control preferences:** Settings offers 4 seconds, 8 seconds or Always visible. Android
  accessibility timeouts are respected; touch exploration keeps controls visible.
- **Pre-call choices:** home-screen options remember start-muted, camera-off and the starting
  camera for both outgoing and joined calls. Preview never opens the microphone. Calls
  still need microphone permission, even when starting muted, so you can unmute later.
- **Share-menu import:** share a complete MC1 text from a compatible app into MirrorCall.
  Offers prefill Join; replies are checked against the current call and prefill Connect.
  Receiving an offer does not open camera/microphone or replace an active call. Some apps
  do not expose Android text sharing; Copy/Paste remains supported.
- **Audio-output picker:** the call's Speaker/Phone control lists available outputs on Android
  12+. It shows the route reported by Android, and keeps your explicit selection across
  resume/interruption when that device is still connected. Older Android keeps the two-way
  Speaker versus Phone/headset selector.
- **Notification controls:** the ongoing-call notification has Mute/Unmute and Hang up.
  Each call has separate action identities; stale actions cannot control a later call.
  Enable notification permission to see these controls. No incoming ringing was added.
- **Call health:** unknown measurements show Not reported. An optional last-call sheet on
  Home shows the last measurement, not an invented whole-call average; clear it anytime.
  It stays in memory only. Diagnostics redact IPv6 as well as IPv4, setup codes/links and
  configured secrets. Existing sampling cadence is retained (30 seconds; 2 seconds while
  details are open). No analytics service or new media library was added.

### If the video-size blip persists

On the affected Android phone, enable **Settings > Display compatibility mode**, save,
then start a new call. It disables WebRTC's resolution-dependent hardware surface sizing;
camera resolution/FPS requests, codec and bitrate settings remain unchanged. It is **off
by default**, because fixed display surfaces can use more graphics power on some phones.
Compare it on/off under the same conditions. This is a targeted compatibility test, not
proof of the cause or a guaranteed fix for the reported iQOO blip.

While enabled, diagnostics records video-dimension and display-size changes (not frames,
images or per-frame logs), using the existing bounded log. If the blip remains, copy that
log after the incident so its timing can be correlated with actual size changes. The earlier
fill/fit threshold fix alone did not eliminate the user's reported symptom.

## Install and call

1. Install `dist/MirrorCall-2.1.0.apk` on **both Android phones**. This uses the same signing
   key as earlier MirrorCall versions and version code 11, so it installs as an update.
   Keep Play Protect enabled and check that the file came from this project.
2. Allow camera and microphone access. Notification permission is optional but helps you
   return to an ongoing call. Android 8 or later and an ARM/ARM64 phone are required.
3. Phone A: **Start a private call**, then **Share code** over WhatsApp.
4. Phone B: copy that code, open **Join with a code**, paste if needed, and **Join call**.
   Share the resulting **reply code** back to A.
5. Phone A: copy the reply and return to MirrorCall. It reads the clipboard when the app
   gains focus. If needed, paste the reply and tap **Connect**.
6. Wait for **Encrypted call** on both phones. Keep the app running during the exchange.

Only A creates the initial call; B answers it. Do not both tap Start and exchange two offers.
Codes belong to a single attempt. Copy and Share contain **only the MC1 code**, without
introductory text. They contain compressed connection details, not video, and are not
processed per video frame. A long code does not make the call choppy.

## What's changed in 2.0

- The Android APK now uses native Google libwebrtc, not WebView, for camera, microphone,
  encoding, decoding, transport and video display. The bundled web page supplies the UI.
- A custom Camera2 capturer prefers a supported fixed/high-minimum frame rate rather than
  a wide range that allows long exposures in low light. It requests fast image processing
  and a resolution the camera reports it can sustain. Dim-light footage can look darker
  or noisier. This does **not** guarantee 30 fps on every device or network.
- H.264 is preferred, with VP8 fallback. Hardware codecs are used where supported, with
  software fallback. Native rendering and texture capture avoid JavaScript pixel copying.
- Native setup codes include local-network candidates, removing the WebView local-address
  restriction. Direct calls can still fail because of router isolation, VPNs, firewalls,
  carrier NAT, changed networks, or stale codes. A TURN relay is supported in code mode.
- Codes are only generated after network candidates are available. Cold network discovery
  gets a bounded extra wait; an address-free code is never offered for sharing.
- Failed connection attempts stay on the call screen with an explanation instead of
  silently returning home. A new connected event can clear the failure state.
- Double-tap either video to swap the large image and small tile; drag the small tile.
- Picture-in-picture keeps video visible when you press Home during a connected call.
  The PiP button opens it manually; the floating window has mute and leave controls.
- Camera start/stop and peer callbacks are guarded against late completion after hang-up.
  ICE gathering no longer blocks camera or hang-up commands while waiting for a network.
- The empty web video markers no longer draw a grey poster over the native image.

## Controls, quality and background use

By default, the call buttons, icons, labels and dark overlay fade out after four seconds
of inactivity once connected. Both videos stay visible. Single-tap the video to hide controls; tap again to bring everything
back. Double-tap near the same spot still swaps videos. Using a control restarts the timer. Open dialogs,
call setup and connection failures keep controls available. Keyboard input also reveals them.

Mirror is remembered. The local preview reflects the mirror setting your partner sees.
Use Mic, Camera, front/rear switch, Chat, and Speaker/Phone controls during the call.
Camera off releases camera capture. The app does not record calls or save chat history.

Native quality starts at **Best: up to 1080p30 / 6 Mbit/s**. Balanced is up to 720p30 /
2.5 Mbit/s; Save data is up to 360p15 / 0.4 Mbit/s. These are ceilings, not promises.
WebRTC lowers quality under load, with a preference for preserving motion. Change quality
from Settings between calls. The user reports good FPS and clarity, but hardware codec support and sustained performance
have not been instrumented on the actual pair of phones.

Pressing Home during a connected call uses Android PiP if allowed. Video and audio continue
while PiP is visible. When the activity is fully hidden, the camera pauses and audio can
continue using a microphone foreground service. Ending a call closes media capture.
Force-stopping, removing the task, or an OS process kill can end a call. There is no incoming
ringing service when the app is closed. On OriginOS, allow background activity for MirrorCall
if the OS kills it while you exchange codes; the exact setting name varies by phone.

Connection details shows codec, encoder, send/receive resolution, frame rate when reported,
encode time, bandwidth/CPU limitation, packet loss and route. An emulator's software codec
performance does not predict phone hardware performance. The selected camera frame-rate
range appears in **Settings ? Copy diagnostics log**. That range is a request, not a measured
frame rate. Share diagnostics privately; do not share setup codes or credentials in bug reports.

The large native call image now consistently fits its available area, rather than switching
between fill and fit at a shape threshold. Some aspect ratios have black bars. Redundant
layout requests are skipped. This removes a confirmed resize discontinuity; it does not
prove every device-specific rendering blip is fixed. Capture and encoding settings are unchanged.

See [UPGRADE_PLAN.md](UPGRADE_PLAN.md) for researched upgrades and the performance gates.

## If the codes do not connect

Start with both phones on the same non-guest Wi-Fi, with client isolation disabled. Use
fresh codes and leave both apps running. Then try separate networks. A direct route is
not available on all networks. A signaling server only exchanges setup messages; it does
not itself improve frame rate. A TURN relay supplies a usable media route when direct
connectivity is blocked; it cannot fix a slow camera or encoder.

To use a relay without a signaling server, enter your provider's **TURN URL, username and
password** in Settings on both phones. The URL is `turn:host:port` or `turns:host:port`,
optionally with a transport query. Multiple URLs can be comma-separated. Credentials must
remain valid for the call. No relay account or credentials are included in this project.
**Relay only** requires a relay and fails closed if none is configured for code mode.

After a Wi-Fi/mobile switch, manual-code calls may need fresh codes. Continual gathering
alone cannot transmit new candidates once the old connection is lost. Hosted signaling
supports ICE restart and candidate exchange, but still cannot guarantee every network.

## Optional hosting

Hosting replaces the manual code exchange with a private invitation. TURN is separate
from signaling and is recommended for connectivity across mobile networks. The servers
relay encrypted setup packets; the media remains WebRTC encrypted in transit.

### Cloudflare Worker and optional Cloudflare TURN

1. Install Node 22+, run `npm install`, then `npx wrangler login`.
2. Generate a strong random server access key locally, then enter it with
   `npx wrangler secret put SERVER_ACCESS_KEY`. Keep it private.
3. For a relay, create a TURN key in the Cloudflare Realtime dashboard. Set the returned
   values using `npx wrangler secret put TURN_KEY_ID` and
   `npx wrangler secret put TURN_KEY_API_TOKEN`.
4. Run `npm run deploy`. Put the resulting HTTPS Worker URL and the server access key in
   MirrorCall Settings on both phones. Do not put the TURN API token into the phone app.
5. If using the hosted web UI too, add its HTTPS origin to `ALLOWED_ORIGINS` in
   `wrangler.toml` and deploy again. The APK origin is already allowed.

Provider account requirements, availability and pricing should be checked before deploying.
The Worker uses a Durable Object for the two-person room. Without TURN configuration it
still depends on a working direct media route.

### Your Linux server with Docker

Use a public IPv4 server with Docker Compose and DNS records `call.example.com` and
`turn.example.com` pointing to it.

1. Open 80/tcp, 443/tcp, 3478/tcp+udp and 49160?49200/udp in the host and provider firewalls.
2. Copy this project to the server. Run `npm run setup`, or copy `.env.example` to `.env`
   and fill the two domains, actual public IP, origins and independent random
   `SERVER_ACCESS_KEY` / `TURN_SHARED_SECRET` values. Never commit `.env`.
3. Run `docker compose up -d --build`. Caddy obtains HTTPS certificates; coturn listens
   on 3478 with the configured UDP relay range. This example does not enable TURN TLS.
4. Verify `https://call.example.com/healthz` returns `{"ok":true}`.
5. Enter the HTTPS call domain and SERVER_ACCESS_KEY in both phones. The server issues
   time-limited relay credentials automatically; do not enter TURN_SHARED_SECRET on phones.

The supplied coturn service uses host networking and expects Linux. Relay credentials
last 24 hours by default; keep calls shorter than their expiry or configure an appropriate
TTL. Review provider bandwidth costs and keep the host patched. No hosting was deployed
as part of this local build.

## Privacy

WebRTC encrypts media with DTLS-SRTP and chat with a DTLS data channel. Setup codes contain
network addresses and certificate fingerprints; compression is **not** encryption. Send
them privately to the intended person. Public STUN services see address discovery requests;
they do not relay your call. Direct peers can learn each other's addresses. Use Relay only
with TURN to avoid offering a direct media route.

Android settings are encrypted using Android Keystore and excluded from backup. The web
version uses browser storage. Copied codes remain in the clipboard until replaced or
cleared. The app has not had an independent security audit; the other participant can
always record what they receive.

## Build and verify

Requirements: Python 3.10+, JDK 17+, Android SDK platform 36 and build-tools 36.0.0.

```powershell
npm install
npm test
npm run test:call
python scripts/build-apk.py --sdk C:\Android\Sdk
```

If Java is not on PATH, add `--java-home "C:\path\to\jdk-17"`. The build downloads the
pinned `io.github.webrtc-sdk:android:150.7871.04` AAR and verifies its SHA-256 before use.
It packages ARM64 and ARMv7 libraries, signs the APK, verifies its signature, and writes a
SHA-256 file next to it. Keep `.signing/` private and backed up: updates need the same key.
Gradle metadata is provided for Android Studio; the command above is the tested build path.

For the Android 16 emulator, build with `--test`, install `build/apk/MirrorCall-test.apk`,
grant camera/microphone/notification permissions, and open it. Then run
`node tests/android/native-call.mjs`. This debuggable build adds x86_64 and WebView debugging;
never distribute it. The test requires Playwright Chromium and adb. It exercises the actual
native engine against a browser peer, checks decoded video and screen pixels, then reverses
roles. `QUALITY=data` is the default because the emulator uses software rendering/encoding.

See [PHONE_TEST_CHECKLIST.md](PHONE_TEST_CHECKLIST.md) for physical-phone acceptance tests.
See [AUDIT.md](AUDIT.md) for this release's verification and remaining limits.

### Source and research

- `app/`: Android lifecycle/audio/PiP, native WebRTC adapter and Camera2 capture.
- `web/engine.mjs`: common interface with native and browser implementations.
- `web/app.mjs`: code exchange, signaling, controls and diagnostics.
- `server/`, `worker/`: Node and Cloudflare signaling; `deploy/`: Docker hosting config.
- `tests/`: server, code format, browser calls, and Android native call integration tests.

Camera behavior was checked against [Android's camera request reference](https://developer.android.com/reference/android/hardware/camera2/CaptureRequest#CONTROL_AE_TARGET_FPS_RANGE)
and [WebRTC Camera2Session](https://webrtc.googlesource.com/src/+/refs/heads/main/sdk/android/src/java/org/webrtc/Camera2Session.java).
PiP follows [Android's PiP lifecycle guidance](https://developer.android.com/develop/ui/views/picture-in-picture).
The pinned native library is published by [webrtc-sdk](https://github.com/webrtc-sdk/android/releases/tag/v150.7871.04).
These sources support the design, not a claim that WhatsApp uses identical internals or
that the cause of the old phone's low frame rate has been measured.

Open-source notices are bundled in `web/NOTICE.txt` and available in Settings. The notice
was copied from `webrtc/NOTICE` in the upstream `webrtc-build` release archive
[webrtc.tar.gz, m150.7871.04](https://github.com/webrtc-sdk/webrtc-build/releases/tag/m150.7871.04).
The Maven AAR itself does not contain a notice file. The archive notice may include
components not used by the Android build.

## Contributing

Contributions are welcome! Please open an issue or pull request. For significant architectural changes, please open an issue first to discuss what you would like to change.

## License

This project is open source and available under the [MIT License](LICENSE).
Third-party component notices and licenses are detailed in `web/NOTICE.txt`.
