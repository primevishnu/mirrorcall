# Test MirrorCall on your phones

Install `dist/MirrorCall-2.1.0.apk` on both Android phones. No rooting or hosted server is
needed for code mode. If an earlier MirrorCall release is already installed, this build uses the same signing key
and a higher version code, so it can be installed as an update.

## First call

1. Start with both phones on the same Wi-Fi. Open the app and allow camera/microphone
   access when requested. Use the same ordinary Wi-Fi (not an isolated guest network).
   If it fails, save diagnostics on both phones; also test a different network.
2. On phone A, tap **Start a private call**. Share the complete setup code over WhatsApp.
3. On phone B, copy the message, open **Join with a code**, and join. If the code is not
   filled in automatically, paste it manually. Send the reply code back to phone A.
4. On phone A, copy the reply and return to MirrorCall. If it does not connect
   automatically, paste the reply into the reply field and tap **Connect**.
5. Confirm that both phones show **Encrypted call** and that each person can hear the other.

## Check the controls

- Once connected, wait four seconds: buttons, labels and icons should fade away while
  both videos continue. Tap to show controls, then single-tap to hide them again. Tapping where a hidden
  mic or hang-up button was must reveal it without muting or ending the call.
- Open chat or connection details for more than four seconds: the controls must remain
  available. Close the dialog and check that hiding resumes.

- Hold up a piece of paper with readable text. Your partner should see reversed text with
  **Mirror on**, and readable text with **Mirror off**. Check their screen, not only yours.
- Mute the microphone. Confirm your partner cannot hear you. Unmute and confirm recovery.
- Turn the camera off. Confirm your partner sees the camera-off screen and Android's camera
  privacy indicator clears. Turn it on again.
- Switch front/rear cameras, then rotate the phone. Check the remote image stays upright.
- Try **Speaker** and **Phone / headset**. Check the actual output device and whether echo
  occurs. On the earpiece, hold the phone to your ear: the screen should turn off.
  Start a call with Bluetooth earbuds connected: audio should start in the earbuds.
  Turn the earbuds off mid-call: audio should move to the loudspeaker, not the earpiece.
- Send a chat message in each direction.
- Double-tap your preview. It should become large while the partner becomes a small
  movable tile. Double-tap again to restore it. Test with one phone rotated sideways.
- During a connected call, press Home or tap PiP. Verify the floating video, outgoing
  camera and audio continue. Test the floating window mute and leave buttons. Restore
  the app and check the layout. Allow PiP in Android settings if it is disabled.
- When the app is fully hidden (PiP disabled or dismissed), your partner should see
  "Video paused" while audio continues. Video should resume on return. If the OS kills
  the call, allow background activity in the OriginOS battery settings and retry.
- Receive a phone call (or set a short alarm) during a call: your partner should see
  "Mic muted" until it ends, and the call should continue.
- Switch dark mode on/off or open split-screen during a call: the call must keep going.
- End the call. Confirm both apps return home and camera/microphone capture ends.

## Check separate networks

Repeat with one phone on mobile data, then with both on separate mobile connections.
If the same-Wi-Fi call works but a separate-network call does not, a TURN relay may be
needed. Manual-code mode has no relay configured by default. Add your own TURN URL and
credentials in Settings on both phones if needed. Changing Wi-Fi/mobile networks during a
manual-code call may require a new code exchange.

For a quality check, open **Connection details** while connected and note the negotiated
codec, **encoder** (implementation name and power-efficiency flag, when reported), sending/receiving
resolution, bitrate and packet loss. Quality settings are upper
limits; actual quality depends on the phone and network.

## If something fails

Note both phone models, Android versions, the exact action, the on-screen message, and
whether the failure occurs on the same Wi-Fi or only on separate networks. Do not publish
setup codes, room invitations, server access keys or private message contents in bug reports.

To enable direct diagnostics on this PC, connect your phone by USB, enable **USB debugging**
in Developer options, and accept the computer authorization prompt. This does not root the
phone or unlock its bootloader. A successful device connection is required before an
on-device install or log check can run.

## Regression checks

- Repeat the call with the other phone starting it. Repeat a second call without closing
  the app; neither camera nor microphone should be stuck from the previous call.
- End a call while the code is being prepared, then start again. Camera startup and ICE
  gathering callbacks must not reopen the old call or camera.
- Submit the wrong reply code; the app should explain the mismatch without closing the call.
- Disconnect the network during setup. A connection failure should stay visible on the
  call screen, rather than silently returning home. Leave and use fresh codes to retry.
- In Settings, enable Relay only without configuring TURN. A manual call must be refused,
  rather than silently leaking a direct connection. Disable it for ordinary direct tests.
- Check that Copy/Share sends only `MC1.?`, and that Open-source licenses works offline.

## Clarity and smoothness

Make a sustained call in both daylight and normal indoor lighting. On each phone, note
camera fps range from diagnostics, Sending fps, Received frame rate, encoder, encode time,
constraint and packet loss. Test Best and Balanced. Range `30-30` is a camera request,
not proof of 30 delivered frames. Hardware fallback, thermal throttling and bandwidth can
still lower quality. A passing emulator test cannot certify either phone's frame rate.

## Video-size blip check (2.0.2)

- Leave both phones untouched in a connected call; watch whether only the image changes size.
- Tap once to hide/show controls: the video geometry must not change. Two quick taps in
  different screen areas must not swap views. Double-tap near the same spot must still swap.
- Rotate one phone and switch its camera; fitting the new image shape is expected.
- Test a normal quality adaptation without rotating: watch for unintended fill/fit jumps.
- If the blip persists, record when it happened and copy diagnostics. Do not assume that
  network FPS adaptation or PiP was the cause. Surface-scaler testing is a separate step.

## 2.1.0 upgrade acceptance

- Set controls to Always visible: neither the inactivity timer nor a video tap should hide
  them. Select 8 seconds and then 4 seconds; confirm the preference survives reopening.
- With TalkBack/touch exploration enabled, controls should remain available. Check large
  text, keyboard focus, tap-to-toggle and double-tap swapping.
- Set start-muted and camera-off on Home. Start a call, and separately answer a call.
  The partner must see the correct states; enabling video/audio later must work normally.
  Home preview must never activate the microphone. Check both front and rear choices.
- Share an offer to MirrorCall from another app: it must prefill Join without starting media.
  Share the reply back: it must match the current attempt. Wrong or malformed codes must
  not end an existing call. Copy/Share still contains only the MC1 code.
- Choose speaker, earpiece and your real headset using the output picker. Check the actual
  sound, not just the label. Disconnect/reconnect the headset and test a phone-call or alarm
  interruption. Verify the selected route recovers without an echo/audio regression.
- Use notification Mute, Unmute and Hang up while MirrorCall is hidden. Repeat in PiP and
  with the screen locked. Old-call actions must not affect a new call. Denying notification
  permission must not prevent an otherwise valid call.
- End a short and a longer call. Last call details must label missing data honestly, omit
  codes/addresses/chat, and disappear when cleared or the app process is restarted.
- For the ongoing size blip, compare Display compatibility mode off/on on the affected
  phone. Watch the FPS, clarity, heat and battery as well as the blip. This setting is a
  controlled test of surface sizing; report the result and diagnostics, not assumptions.
