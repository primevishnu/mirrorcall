package app.mirrorcall.android;

import android.app.Activity;
import android.media.AudioAttributes;
import android.view.View;
import android.widget.FrameLayout;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.DataChannel;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.MediaStreamTrack;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.Priority;
import org.webrtc.RTCStats;
import org.webrtc.RendererCommon;
import org.webrtc.RtpCapabilities;
import org.webrtc.RtpParameters;
import org.webrtc.RtpReceiver;
import org.webrtc.RtpSender;
import org.webrtc.RtpTransceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.SurfaceViewRenderer;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;
import org.webrtc.audio.JavaAudioDeviceModule;

/**
 * Native call engine (Google libwebrtc). The web page keeps the interface and the signalling
 * (codes, invitations, chat UI); this class owns the camera, microphone, encoders, the peer
 * connection and the on-screen video. Commands arrive as JSON from the page and are answered
 * as {id, result|error}; asynchronous happenings are sent as {event, ...}.
 */
final class NativeEngine {
    interface Host {
        void emit(String json);
        void requestPermissions(boolean audio, boolean video, PermissionResult result);
        void onRemoteVideoSize(int width, int height);
    }
    interface PermissionResult { void done(boolean audioGranted, boolean videoGranted); }

    private final Activity activity;
    private final Host host;
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    private volatile boolean disposed;
    private int mediaGeneration, openingVideoId;
    final EglBase egl = EglBase.create();
    final SurfaceViewRenderer bottomView, topView;

    private PeerConnectionFactory factory;
    private AudioSource audioSource;
    private AudioTrack audioTrack;
    private boolean micEnabled = true;
    private VideoSource videoSource;
    private VideoTrack videoTrack;
    private SurfaceTextureHelper textureHelper;
    private MaxFpsCameraCapturer capturer;
    private volatile PeerConnection pc;
    private RtpTransceiver audioTx, videoTx;
    private DataChannel channel;
    private VideoTrack remoteTrack;
    private volatile long lastCandidateAt;
    private volatile boolean sawPublicCandidate;
    private boolean continualGathering;
    // Which view shows what (the small tile always uses the media-overlay "top" surface).
    private volatile boolean localOnTop = true;
    private boolean localMirror, remoteMirror;
    private VideoTrack bottomTrack, topTrack;
    private JSONObject bottomRect;
    private boolean bottomFill;
    private int bottomFrameWidth, bottomFrameHeight;
    private volatile boolean displayCompatibility;

    NativeEngine(Activity activity, Host host) {
        this.activity = activity;
        this.host = host;
        bottomView = new SurfaceViewRenderer(activity);
        topView = new SurfaceViewRenderer(activity);
        topView.setZOrderMediaOverlay(true);
        for (SurfaceViewRenderer view : new SurfaceViewRenderer[] { bottomView, topView }) {
            view.init(egl.getEglBaseContext(), new RendererCommon.RendererEvents() {
                @Override public void onFirstFrameRendered() {}
                @Override public void onFrameResolutionChanged(int width, int height, int rotation) {
                    int w = rotation % 180 == 0 ? width : height, h = rotation % 180 == 0 ? height : width;
                    // Shape the picture-in-picture window like your partner's video.
                    boolean showsRemote = (view == bottomView) == localOnTop;
                    if (showsRemote && displayCompatibility) event("displayFrame", "detail", w + "x" + h + " rotation=" + rotation);
                    if (showsRemote) activity.runOnUiThread(() -> host.onRemoteVideoSize(w, h));
                    if (view == bottomView) activity.runOnUiThread(() -> { bottomFrameWidth = w; bottomFrameHeight = h; placeBottom(); });
                }
            });
            view.setEnableHardwareScaler(true);
            view.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL);
            view.setVisibility(View.GONE);
        }
    }

    // ---------------- Command dispatch ----------------

    // Native callbacks run on WebRTC/Camera2 threads. Serialize ownership changes with
    // commands, and discard callbacks after teardown instead of touching disposed objects.
    private void enqueue(Runnable task) {
        if (disposed) return;
        try { worker.execute(() -> { if (!disposed) task.run(); }); }
        catch (RejectedExecutionException ignored) {}
    }

    void handle(String json) {
        enqueue(() -> {
            int id = 0;
            try {
                JSONObject message = new JSONObject(json);
                id = message.optInt("id");
                JSONObject args = message.optJSONObject("args");
                if (args == null) args = new JSONObject();
                dispatch(id, message.getString("method"), args);
            } catch (Exception error) {
                fail(id, "Error", String.valueOf(error.getMessage()));
            }
        });
    }

    private void dispatch(int id, String method, JSONObject a) throws JSONException {
        switch (method) {
            case "open": open(id, a); break;
            case "closeVideo": stopVideo(); reply(id, null); break;
            case "closeAll": mediaGeneration++; stopVideo(); stopAudio(); reply(id, null); break;
            case "setMic": micEnabled = a.getBoolean("enabled"); if (audioTrack != null) audioTrack.setEnabled(micEnabled); reply(id, null); break;
            case "layout": layout(a); reply(id, null); break;
            case "displayMode": {
                boolean compatibility = a.optBoolean("compatibility");
                activity.runOnUiThread(() -> {
                    if (disposed) { fail(id, "AbortError", "Display closed"); return; }
                    displayCompatibility = compatibility;
                    // Opt-in device workaround: keep surface allocation tied to the view,
                    // rather than resize its buffer when the incoming resolution adapts.
                    bottomView.setEnableHardwareScaler(!compatibility);
                    topView.setEnableHardwareScaler(!compatibility);
                    event("displayMode", "state", compatibility ? "compatibility" : "hardware-scaler");
                    reply(id, null);
                });
                break;
            }
            case "createPeer": createPeer(a); reply(id, null); break;
            case "offer": offer(id, a.optBoolean("restart")); break;
            case "answer": answer(id, a.getString("sdp")); break;
            case "applyAnswer": setRemote(id, SessionDescription.Type.ANSWER, a.getString("sdp"), () -> reply(id, null)); break;
            case "addCandidate": addCandidate(a); reply(id, null); break;
            case "waitGathering": waitGathering(id, a.optInt("ms", 6000)); break;
            case "localDescription": reply(id, describe(pc == null ? null : pc.getLocalDescription())); break;
            case "send": reply(id, send(a.getString("text"))); break;
            case "tune": tune(a); reply(id, null); break;
            case "stats": stats(id); break;
            case "closePeer": closePeer(); reply(id, null); break;
            default: fail(id, "NotSupportedError", "Unknown method " + method);
        }
    }

    private void reply(int id, Object result) {
        if (id == 0) return;
        try { host.emit(new JSONObject().put("id", id).put("result", result == null ? JSONObject.NULL : result).toString()); }
        catch (JSONException ignored) {}
    }

    private void fail(int id, String name, String message) {
        if (id == 0) return;
        try { host.emit(new JSONObject().put("id", id).put("error", new JSONObject().put("name", name).put("message", message)).toString()); }
        catch (JSONException ignored) {}
    }

    private void event(String name, Object... pairs) {
        try {
            JSONObject json = new JSONObject().put("event", name);
            for (int i = 0; i + 1 < pairs.length; i += 2) json.put((String) pairs[i], pairs[i + 1]);
            host.emit(json.toString());
        } catch (JSONException ignored) {}
    }

    // ---------------- Factory ----------------

    private void ensureFactory() {
        if (factory != null) return;
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(activity.getApplicationContext()).createInitializationOptions());
        JavaAudioDeviceModule audioModule = JavaAudioDeviceModule.builder(activity.getApplicationContext())
            .setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true)
            .setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioRecordErrorCallback(new JavaAudioDeviceModule.AudioRecordErrorCallback() {
                @Override public void onWebRtcAudioRecordInitError(String message) { event("audioError", "message", "record-init"); }
                @Override public void onWebRtcAudioRecordStartError(JavaAudioDeviceModule.AudioRecordStartErrorCode code, String message) { event("audioError", "message", "record-start " + code); }
                @Override public void onWebRtcAudioRecordError(String message) { event("audioError", "message", "record"); }
            })
            .createAudioDeviceModule();
        factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(audioModule)
            // Hardware encoders first (with software fallback); H.264 High profile for quality per bit.
            .setVideoEncoderFactory(new DefaultVideoEncoderFactory(egl.getEglBaseContext(), true, true))
            .setVideoDecoderFactory(new DefaultVideoDecoderFactory(egl.getEglBaseContext()))
            .createPeerConnectionFactory();
        audioModule.release(); // the factory holds its own reference
    }

    // ---------------- Media ----------------

    private void open(int id, JSONObject a) {
        final int generation = mediaGeneration;
        boolean wantAudio = a.optBoolean("audio") && audioTrack == null;
        boolean wantVideo = a.optBoolean("video") && videoTrack == null;
        if (!wantAudio && !wantVideo) { reply(id, mediaState()); return; }
        host.requestPermissions(wantAudio, wantVideo, (audioOk, videoOk) -> enqueue(() -> {
            if (generation != mediaGeneration) { fail(id, "AbortError", "Media request cancelled"); return; }
            if ((wantAudio && !audioOk) || (wantVideo && !videoOk)) { fail(id, "NotAllowedError", "permission"); return; }
            try {
                ensureFactory();
                if (wantAudio) startAudio();
                if (!wantVideo) { reply(id, mediaState()); return; }
                startVideo(a.optBoolean("front", true), a.optInt("width", 1280), a.optInt("height", 720), a.optInt("fps", 30), id);
            } catch (RuntimeException error) {
                fail(id, "NotReadableError", String.valueOf(error.getMessage()));
            }
        }));
    }

    private JSONObject mediaState() {
        try { return new JSONObject().put("audio", audioTrack != null).put("video", videoTrack != null); }
        catch (JSONException e) { return new JSONObject(); }
    }

    private void startAudio() {
        MediaConstraints constraints = new MediaConstraints();
        for (String key : new String[] { "googEchoCancellation", "googAutoGainControl", "googNoiseSuppression", "googHighpassFilter" }) {
            constraints.mandatory.add(new MediaConstraints.KeyValuePair(key, "true"));
        }
        audioSource = factory.createAudioSource(constraints);
        audioTrack = factory.createAudioTrack("mic", audioSource);
        audioTrack.setEnabled(micEnabled);
        if (audioTx != null) audioTx.getSender().setTrack(audioTrack, false);
    }

    private void stopAudio() {
        if (audioTx != null) audioTx.getSender().setTrack(null, false);
        if (audioTrack != null) { audioTrack.dispose(); audioTrack = null; }
        if (audioSource != null) { audioSource.dispose(); audioSource = null; }
    }

    private void startVideo(boolean front, int width, int height, int fps, int replyId) {
        openingVideoId = replyId;
        videoSource = factory.createVideoSource(false);
        textureHelper = SurfaceTextureHelper.create("camera", egl.getEglBaseContext());
        final VideoSource source = videoSource;
        final AtomicBoolean answered = new AtomicBoolean(false);
        capturer = new MaxFpsCameraCapturer(activity, front, new MaxFpsCameraCapturer.Listener() {
            @Override public void onStarted(String description) {
                enqueue(() -> {
                    if (videoSource != source) return;
                    event("camera", "state", "started", "detail", description);
                    if (answered.compareAndSet(false, true)) { openingVideoId = 0; reply(replyId, mediaState()); }
                });
            }
            @Override public void onError(String reason, boolean busy) {
                enqueue(() -> {
                    if (videoSource != source) return;
                    openingVideoId = 0;
                    stopVideo();
                    // Failing to start answers the open request; failing later (another app took
                    // the camera) is reported as an event so the call can continue with audio.
                    if (answered.compareAndSet(false, true)) fail(replyId, busy ? "NotReadableError" : "NotFoundError", reason);
                    else event("camera", "state", "lost", "detail", reason);
                });
            }
        });
        capturer.initialize(textureHelper, activity.getApplicationContext(), videoSource.getCapturerObserver());
        videoTrack = factory.createVideoTrack("camera", videoSource);
        if (videoTx != null) videoTx.getSender().setTrack(videoTrack, false);
        capturer.startCapture(width, height, fps);
        routeVideo();
    }

    private void stopVideo() {
        if (openingVideoId != 0) { fail(openingVideoId, "AbortError", "Camera request cancelled"); openingVideoId = 0; }
        if (videoTx != null) videoTx.getSender().setTrack(null, false);
        VideoTrack track = videoTrack;
        videoTrack = null;
        routeVideo();
        if (capturer != null) { capturer.dispose(); capturer = null; }
        if (track != null) track.dispose();
        if (videoSource != null) { videoSource.dispose(); videoSource = null; }
        if (textureHelper != null) { textureHelper.dispose(); textureHelper = null; }
    }

    // ---------------- Views ----------------

    private void layout(JSONObject a) {
        localOnTop = a.optBoolean("localOnTop", true);
        localMirror = a.optBoolean("localMirror");
        remoteMirror = a.optBoolean("remoteMirror");
        JSONObject local = a.optJSONObject("local"), remote = a.optJSONObject("remote");
        JSONObject bottom = localOnTop ? remote : local, top = localOnTop ? local : remote;
        boolean fill = a.optBoolean("bottomFill");
        activity.runOnUiThread(() -> {
            bottomRect = bottom;
            bottomFill = fill;
            placeBottom();
            place(topView, top);
            bottomView.setMirror(localOnTop ? remoteMirror : localMirror);
            topView.setMirror(localOnTop ? localMirror : remoteMirror);
        });
        routeVideo();
    }

    /**
     * Fit the full call image consistently. Switching between fill and fit at an aspect-ratio
     * threshold makes the image jump when the received shape crosses that threshold.
     * The home preview still uses fill; a call may have bars when screen/video shapes differ.
     */
    private void placeBottom() {
        JSONObject rect = bottomRect;
        if (rect == null || bottomFill || bottomFrameWidth <= 0 || bottomFrameHeight <= 0) { place(bottomView, rect); return; }
        int x = rect.optInt("x"), y = rect.optInt("y"), w = rect.optInt("w"), h = rect.optInt("h");
        if (w <= 0 || h <= 0) { place(bottomView, null); return; }
        double frame = (double) bottomFrameWidth / bottomFrameHeight, area = (double) w / h;
        int fitW = frame > area ? w : (int) Math.round(h * frame);
        int fitH = frame > area ? (int) Math.round(w / frame) : h;
        try { place(bottomView, new JSONObject().put("x", x + (w - fitW) / 2).put("y", y + (h - fitH) / 2).put("w", fitW).put("h", fitH)); }
        catch (JSONException ignored) {}
    }

    private void place(SurfaceViewRenderer view, JSONObject rect) {
        if (rect == null || rect.optInt("w") <= 0 || rect.optInt("h") <= 0) {
            if (view.getVisibility() != View.GONE) { view.setVisibility(View.GONE); view.clearImage(); }
            return;
        }
        int w = rect.optInt("w"), h = rect.optInt("h"), x = rect.optInt("x"), y = rect.optInt("y");
        FrameLayout.LayoutParams current = (FrameLayout.LayoutParams) view.getLayoutParams();
        if (current == null || current.width != w || current.height != h || current.leftMargin != x || current.topMargin != y) {
            if (view == bottomView && displayCompatibility && (current == null || current.width != w || current.height != h)) event("displayLayout", "detail", w + "x" + h);
            FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(w, h);
            params.leftMargin = x;
            params.topMargin = y;
            view.setLayoutParams(params);
        }
        if (view.getVisibility() != View.VISIBLE) view.setVisibility(View.VISIBLE);
    }

    private synchronized void routeVideo() {
        VideoTrack wantBottom = localOnTop ? remoteTrack : videoTrack;
        VideoTrack wantTop = localOnTop ? videoTrack : remoteTrack;
        if (bottomTrack != wantBottom) { if (bottomTrack != null) safeRemove(bottomTrack, bottomView); if (wantBottom != null) wantBottom.addSink(bottomView); bottomTrack = wantBottom; }
        if (topTrack != wantTop) { if (topTrack != null) safeRemove(topTrack, topView); if (wantTop != null) wantTop.addSink(topView); topTrack = wantTop; }
    }

    private static void safeRemove(VideoTrack track, SurfaceViewRenderer view) {
        try { track.removeSink(view); } catch (IllegalStateException disposed) {}
        view.clearImage();
    }

    // ---------------- Peer connection ----------------

    private void createPeer(JSONObject a) throws JSONException {
        closePeer();
        ensureFactory();
        List<PeerConnection.IceServer> servers = new ArrayList<>();
        JSONArray list = a.optJSONArray("iceServers");
        for (int i = 0; list != null && i < list.length(); i++) {
            JSONObject server = list.getJSONObject(i);
            List<String> urls = new ArrayList<>();
            Object raw = server.opt("urls");
            if (raw instanceof JSONArray) for (int j = 0; j < ((JSONArray) raw).length(); j++) urls.add(((JSONArray) raw).getString(j));
            else if (raw != null) urls.add(String.valueOf(raw));
            PeerConnection.IceServer.Builder builder = PeerConnection.IceServer.builder(urls);
            if (server.has("username")) builder.setUsername(server.getString("username"));
            if (server.has("credential")) builder.setPassword(server.getString("credential"));
            servers.add(builder.createIceServer());
        }
        PeerConnection.RTCConfiguration config = new PeerConnection.RTCConfiguration(servers);
        config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        config.bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE;
        config.rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE;
        config.iceTransportsType = a.optBoolean("relayOnly") ? PeerConnection.IceTransportsType.RELAY : PeerConnection.IceTransportsType.ALL;
        // Server mode can signal new candidates after a network change. Manual codes cannot
        // exchange new candidates once the original route is lost, so recovery is not guaranteed.
        continualGathering = a.optBoolean("continual");
        config.continualGatheringPolicy = continualGathering
            ? PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY : PeerConnection.ContinualGatheringPolicy.GATHER_ONCE;
        config.keyType = PeerConnection.KeyType.ECDSA;
        lastCandidateAt = 0;
        sawPublicCandidate = false;
        final PeerConnection[] self = new PeerConnection[1];
        PeerConnection created = factory.createPeerConnection(config, new PeerConnection.Observer() {
            @Override public void onSignalingChange(PeerConnection.SignalingState state) {}
            @Override public void onIceConnectionChange(PeerConnection.IceConnectionState state) { enqueue(() -> { if (self[0] == pc) event("ice", "state", state.name().toLowerCase()); }); }
            @Override public void onConnectionChange(PeerConnection.PeerConnectionState state) { enqueue(() -> { if (self[0] == pc) event("connection", "state", state.name().toLowerCase()); }); }
            @Override public void onIceConnectionReceivingChange(boolean receiving) {}
            @Override public void onIceGatheringChange(PeerConnection.IceGatheringState state) {}
            @Override public void onIceCandidate(IceCandidate candidate) {
                enqueue(() -> {
                if (self[0] != pc) return;
                lastCandidateAt = System.currentTimeMillis();
                if (candidate.sdp.contains(" typ srflx") || candidate.sdp.contains(" typ relay")) sawPublicCandidate = true;
                try { event("candidate", "candidate", new JSONObject().put("candidate", "candidate:" + candidate.sdp.replaceFirst("^candidate:", "")).put("sdpMid", candidate.sdpMid).put("sdpMLineIndex", candidate.sdpMLineIndex)); }
                catch (JSONException ignored) {}
                });
            }
            @Override public void onIceCandidatesRemoved(IceCandidate[] candidates) {}
            @Override public void onAddStream(MediaStream stream) {}
            @Override public void onRemoveStream(MediaStream stream) {}
            @Override public void onDataChannel(DataChannel dataChannel) { enqueue(() -> { if (self[0] == pc) wireChannel(dataChannel); }); }
            @Override public void onRenegotiationNeeded() {}
            @Override public void onTrack(RtpTransceiver transceiver) {
                enqueue(() -> {
                if (self[0] != pc) return;
                MediaStreamTrack track = transceiver.getReceiver().track();
                if (track instanceof VideoTrack) {
                    remoteTrack = (VideoTrack) track;
                    routeVideo();
                    event("remoteVideo");
                }
                });
            }
        });
        self[0] = created;
        pc = created;
        if (a.optBoolean("initiator")) {
            audioTx = pc.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO, new RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV, Collections.singletonList("call")));
            videoTx = pc.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO, new RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV, Collections.singletonList("call")));
            if (audioTrack != null) audioTx.getSender().setTrack(audioTrack, false);
            if (videoTrack != null) videoTx.getSender().setTrack(videoTrack, false);
            preferCodecs(videoTx);
            DataChannel.Init init = new DataChannel.Init();
            init.ordered = true;
            wireChannel(pc.createDataChannel("private-chat", init));
        }
    }

    private void closePeer() {
        PeerConnection old = pc;
        pc = null;
        if (channel != null) { channel.unregisterObserver(); channel.dispose(); channel = null; }
        if (remoteTrack != null) { remoteTrack = null; routeVideo(); }
        activity.runOnUiThread(() -> { bottomFrameWidth = 0; bottomFrameHeight = 0; });
        audioTx = videoTx = null;
        if (old != null) { old.close(); old.dispose(); }
    }

    /** H.264 first (hardware-encoded on practically every phone), then VP8; keep RTX/RED/FEC for loss recovery. */
    private void preferCodecs(RtpTransceiver transceiver) {
        if (transceiver == null) return;
        try {
            List<RtpCapabilities.CodecCapability> sorted = new ArrayList<>();
            for (RtpCapabilities.CodecCapability codec : factory.getRtpReceiverCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO).codecs) {
                String name = codec.name.toUpperCase();
                if (name.equals("H264") || name.equals("VP8") || name.equals("RTX") || name.equals("RED") || name.equals("ULPFEC") || name.equals("FLEXFEC-03")) sorted.add(codec);
            }
            Collections.sort(sorted, (x, y) -> rank(x) - rank(y));
            if (!sorted.isEmpty()) transceiver.setCodecPreferences(sorted);
        } catch (RuntimeException ignored) {}
    }

    private static int rank(RtpCapabilities.CodecCapability codec) {
        String name = codec.name.toUpperCase();
        if (name.equals("H264")) {
            String profile = codec.parameters == null ? "" : String.valueOf(codec.parameters.get("profile-level-id"));
            boolean mode1 = codec.parameters != null && "1".equals(codec.parameters.get("packetization-mode"));
            return (profile.startsWith("64") ? 0 : 1) + (mode1 ? 0 : 2);
        }
        return name.equals("VP8") ? 5 : 9;
    }

    private void wireChannel(DataChannel dc) {
        if (channel != null) { channel.unregisterObserver(); channel.dispose(); }
        channel = dc;
        dc.registerObserver(new DataChannel.Observer() {
            @Override public void onBufferedAmountChange(long previous) {}
            @Override public void onStateChange() {
                enqueue(() -> {
                if (channel != dc) return;
                DataChannel.State state = dc.state();
                if (state == DataChannel.State.OPEN) event("channel", "state", "open");
                else if (state == DataChannel.State.CLOSED) event("channel", "state", "closed");
                });
            }
            @Override public void onMessage(DataChannel.Buffer buffer) {
                if (buffer.binary || buffer.data.remaining() > 8192) return;
                byte[] bytes = new byte[buffer.data.remaining()];
                buffer.data.get(bytes);
                enqueue(() -> { if (channel == dc) event("message", "text", new String(bytes, StandardCharsets.UTF_8)); });
            }
        });
        if (dc.state() == DataChannel.State.OPEN) event("channel", "state", "open");
    }

    private Object send(String text) {
        if (channel == null || channel.state() != DataChannel.State.OPEN) return false;
        if (channel.bufferedAmount() > 64_000) return "busy";
        return channel.send(new DataChannel.Buffer(ByteBuffer.wrap(text.getBytes(StandardCharsets.UTF_8)), false));
    }

    private abstract static class Sdp implements SdpObserver {
        @Override public void onCreateSuccess(SessionDescription description) {}
        @Override public void onSetSuccess() {}
        @Override public void onCreateFailure(String error) {}
        @Override public void onSetFailure(String error) {}
    }

    private static JSONObject describe(SessionDescription description) {
        if (description == null) return null;
        try { return new JSONObject().put("type", description.type.canonicalForm()).put("sdp", description.description); }
        catch (JSONException e) { return null; }
    }

    private void withPeer(PeerConnection peer, int id, Runnable task) {
        enqueue(() -> {
            if (peer != pc) { fail(id, "AbortError", "Call ended"); return; }
            task.run();
        });
    }

    private void offer(int id, boolean restart) {
        PeerConnection peer = pc;
        if (peer == null) { reply(id, null); return; }
        Runnable create = () -> {
            if (peer.signalingState() != PeerConnection.SignalingState.STABLE) { reply(id, null); return; }
            MediaConstraints constraints = new MediaConstraints();
            if (restart) constraints.mandatory.add(new MediaConstraints.KeyValuePair("IceRestart", "true"));
            peer.createOffer(new Sdp() {
                @Override public void onCreateSuccess(SessionDescription description) {
                    withPeer(peer, id, () -> {
                    peer.setLocalDescription(new Sdp() {
                        @Override public void onSetSuccess() { withPeer(peer, id, () -> reply(id, describe(peer.getLocalDescription()))); }
                        @Override public void onSetFailure(String error) { fail(id, "OperationError", error); }
                    }, description);
                    });
                }
                @Override public void onCreateFailure(String error) { fail(id, "OperationError", error); }
            }, constraints);
        };
        if (peer.signalingState() == PeerConnection.SignalingState.HAVE_LOCAL_OFFER) {
            if (!restart) { reply(id, null); return; }
            peer.setLocalDescription(new Sdp() {
                @Override public void onSetSuccess() { withPeer(peer, id, create); }
                @Override public void onSetFailure(String error) { fail(id, "OperationError", error); }
            }, new SessionDescription(SessionDescription.Type.ROLLBACK, ""));
        } else create.run();
    }

    private void setRemote(int id, SessionDescription.Type type, String sdp, Runnable then) {
        PeerConnection peer = pc;
        if (peer == null) { fail(id, "InvalidStateError", "no peer"); return; }
        peer.setRemoteDescription(new Sdp() {
            @Override public void onSetSuccess() { withPeer(peer, id, then); }
            @Override public void onSetFailure(String error) { fail(id, "InvalidAccessError", error); }
        }, new SessionDescription(type, sdp));
    }

    private void answer(int id, String sdp) {
        setRemote(id, SessionDescription.Type.OFFER, sdp, () -> {
            PeerConnection peer = pc;
            if (peer == null) { fail(id, "InvalidStateError", "no peer"); return; }
            if (videoTx == null) {
                for (RtpTransceiver transceiver : peer.getTransceivers()) {
                    MediaStreamTrack.MediaType type = transceiver.getMediaType();
                    if (type == MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO && audioTx == null) audioTx = transceiver;
                    else if (type == MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO && videoTx == null) videoTx = transceiver;
                    else continue;
                    transceiver.setDirection(RtpTransceiver.RtpTransceiverDirection.SEND_RECV);
                    transceiver.getSender().setStreams(Collections.singletonList("call"));
                }
                if (audioTx != null && audioTrack != null) audioTx.getSender().setTrack(audioTrack, false);
                if (videoTx != null && videoTrack != null) videoTx.getSender().setTrack(videoTrack, false);
                preferCodecs(videoTx);
            }
            peer.createAnswer(new Sdp() {
                @Override public void onCreateSuccess(SessionDescription description) {
                    withPeer(peer, id, () -> {
                    peer.setLocalDescription(new Sdp() {
                        @Override public void onSetSuccess() { withPeer(peer, id, () -> reply(id, describe(peer.getLocalDescription()))); }
                        @Override public void onSetFailure(String error) { fail(id, "OperationError", error); }
                    }, description);
                    });
                }
                @Override public void onCreateFailure(String error) { fail(id, "OperationError", error); }
            }, new MediaConstraints());
        });
    }

    private void addCandidate(JSONObject a) {
        if (pc == null) return;
        String sdp = a.optString("candidate");
        if (sdp.isEmpty()) return;
        pc.addIceCandidate(new IceCandidate(a.optString("sdpMid", "0"), a.optInt("sdpMLineIndex"), sdp));
    }

    /** Poll without blocking media, hang-up or lifecycle commands while STUN/TURN responds. */
    private void waitGathering(int id, int maxMs) {
        final PeerConnection peer = pc;
        final long start = android.os.SystemClock.elapsedRealtime();
        final long deadline = start + Math.max(0, Math.min(maxMs, 15000));
        Runnable check = new Runnable() {
            @Override public void run() {
                if (disposed) return;
                if (peer == null || peer != pc) { reply(id, null); return; }
                boolean settled = continualGathering && sawPublicCandidate && lastCandidateAt > 0 && System.currentTimeMillis() - lastCandidateAt > 700;
                SessionDescription description = peer.getLocalDescription();
                boolean hasRoute = description != null && description.description.contains("\na=candidate:");
                long now = android.os.SystemClock.elapsedRealtime();
                // On a cold/loaded device network discovery can lag behind SDP creation.
                // Never export an address-free code just because the soft timer elapsed.
                if (hasRoute && (settled || peer.iceGatheringState() == PeerConnection.IceGatheringState.COMPLETE || now >= deadline)) {
                    reply(id, describe(description));
                } else if (now >= start + 15000) {
                    fail(id, "NetworkError", "No usable network address was found. Check your connection or TURN settings and start a fresh call.");
                } else worker.schedule(this, 100, TimeUnit.MILLISECONDS);
            }
        };
        check.run();
    }

    private void tune(JSONObject a) {
        if (videoTx != null) {
            RtpSender sender = videoTx.getSender();
            RtpParameters params = sender.getParameters();
            params.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_FRAMERATE;
            for (RtpParameters.Encoding encoding : params.encodings) {
                encoding.maxBitrateBps = a.optInt("bitrate", 2_500_000);
                encoding.maxFramerate = a.optInt("fps", 30);
            }
            sender.setParameters(params);
        }
        if (audioTx != null) {
            RtpSender sender = audioTx.getSender();
            RtpParameters params = sender.getParameters();
            for (RtpParameters.Encoding encoding : params.encodings) {
                encoding.maxBitrateBps = a.optInt("audioBitrate", 64_000);
                encoding.networkPriority = Priority.HIGH;
                encoding.bitratePriority = 4.0;
            }
            sender.setParameters(params);
        }
    }

    private static final String[] STAT_TYPES = { "outbound-rtp", "inbound-rtp", "transport", "candidate-pair", "local-candidate", "remote-candidate", "codec" };

    private void stats(int id) {
        PeerConnection peer = pc;
        if (peer == null) { reply(id, new JSONArray()); return; }
        peer.getStats(report -> {
            JSONArray out = new JSONArray();
            for (RTCStats stat : report.getStatsMap().values()) {
                boolean wanted = false;
                for (String type : STAT_TYPES) if (type.equals(stat.getType())) wanted = true;
                if (!wanted) continue;
                try {
                    JSONObject json = new JSONObject().put("type", stat.getType()).put("id", stat.getId());
                    for (Map.Entry<String, Object> member : stat.getMembers().entrySet()) {
                        Object value = member.getValue();
                        if (value instanceof Number || value instanceof String || value instanceof Boolean) json.put(member.getKey(), value);
                        else if (value instanceof BigInteger) json.put(member.getKey(), ((BigInteger) value).longValue());
                    }
                    out.put(json);
                } catch (JSONException ignored) {}
            }
            reply(id, out);
        });
    }

    void dispose() {
        disposed = true;
        worker.execute(() -> {
            closePeer();
            stopVideo();
            stopAudio();
            if (factory != null) { factory.dispose(); factory = null; }
            bottomView.release();
            topView.release();
            egl.release();
        });
        worker.shutdown();
    }
}
