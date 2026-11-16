package app.mirrorcall.android;

import android.content.Context;
import android.graphics.Matrix;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.os.Handler;
import android.util.Range;
import android.util.Size;
import android.view.Surface;
import android.view.WindowManager;
import java.util.Collections;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.webrtc.CapturerObserver;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.TextureBufferImpl;
import org.webrtc.VideoCapturer;
import org.webrtc.VideoFrame;

/**
 * Camera2 capturer tuned for frame rate. Chromium and the stock WebRTC capturer both pick the
 * auto-exposure range with the LOWEST minimum (for example 7–30 fps), so in indoor light the
 * camera lengthens exposures and delivers 7–10 fps. This capturer picks the range with the
 * HIGHEST minimum (30–30, else 24–30 …), only resolutions the sensor can stream at that rate,
 * and the FAST (never frame-rate-reducing) post-processing modes. Frames stay as GPU textures
 * all the way to the hardware encoder. Mirroring/rotation handling matches WebRTC's own
 * Camera2Session: the sent image is the true (unmirrored) view, rotation is signalled as metadata.
 */
final class MaxFpsCameraCapturer implements VideoCapturer {
    interface Listener {
        void onStarted(String description);
        void onError(String reason, boolean busy);
    }

    private final Context context;
    private final boolean wantFront;
    private final Listener listener;
    private SurfaceTextureHelper helper;
    private CapturerObserver observer;
    private Handler handler;
    private CameraDevice camera;
    private CameraCaptureSession session;
    private Surface surface;
    private int sensorOrientation;
    private boolean front;
    private volatile boolean running;
    // Camera2 open/configure callbacks may arrive after stopCapture or a format change.
    // Only the current attempt may own the surface or notify the engine.
    private int generation;

    MaxFpsCameraCapturer(Context context, boolean front, Listener listener) {
        this.context = context.getApplicationContext();
        this.wantFront = front;
        this.listener = listener;
    }

    @Override public void initialize(SurfaceTextureHelper helper, Context ignored, CapturerObserver observer) {
        this.helper = helper;
        this.observer = observer;
        this.handler = helper.getHandler();
    }

    @Override public void startCapture(int width, int height, int fps) {
        handler.post(() -> open(width, height, fps));
    }

    @Override public void stopCapture() throws InterruptedException {
        if (Thread.currentThread() == handler.getLooper().getThread()) { close(); return; }
        CountDownLatch done = new CountDownLatch(1);
        handler.post(() -> { close(); done.countDown(); });
        done.await(3, TimeUnit.SECONDS);
    }

    @Override public void changeCaptureFormat(int width, int height, int fps) {
        handler.post(() -> { close(); open(width, height, fps); });
    }

    @Override public void dispose() {
        try { stopCapture(); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
    }

    @Override public boolean isScreencast() { return false; }

    // ---- Selection: the core of the frame-rate fix ----

    /** Highest guaranteed minimum (capped at the target), then the upper bound closest to the target. */
    static Range<Integer> pickFpsRange(Range<Integer>[] ranges, int target) {
        Range<Integer> best = null;
        long bestScore = Long.MIN_VALUE;
        int factor = ranges.length > 0 && ranges[0].getUpper() > 1000 ? 1000 : 1;
        for (Range<Integer> range : ranges) {
            int lower = range.getLower() / factor, upper = range.getUpper() / factor;
            long score = (long) Math.min(lower, target) * 1000 - Math.abs(upper - target) * 10 + (upper >= target ? 5 : 0);
            if (score > bestScore) { bestScore = score; best = range; }
        }
        return best;
    }

    /** Largest size not exceeding the request that the sensor can stream at the chosen rate, preferring the requested aspect. */
    static Size pickSize(StreamConfigurationMap map, int width, int height, int fps) {
        Size[] sizes = map.getOutputSizes(SurfaceTexture.class);
        if (sizes == null || sizes.length == 0) return new Size(width, height);
        long maxDuration = 1_000_000_000L / Math.max(1, fps);
        double aspect = (double) Math.max(width, height) / Math.min(width, height);
        Size best = null;
        long bestScore = Long.MIN_VALUE;
        for (Size size : sizes) {
            int w = Math.max(size.getWidth(), size.getHeight()), h = Math.min(size.getWidth(), size.getHeight());
            if (w > Math.max(width, height) || h > Math.min(width, height)) continue;
            long duration = map.getOutputMinFrameDuration(SurfaceTexture.class, size);
            boolean fastEnough = duration <= 0 || duration <= maxDuration;
            boolean sameAspect = Math.abs((double) w / h - aspect) < 0.02;
            long score = (fastEnough ? 4_000_000_000L : 0) + (sameAspect ? 2_000_000_000L : 0) + (long) w * h;
            if (score > bestScore) { bestScore = score; best = size; }
        }
        if (best != null) return best;
        Size smallest = sizes[0];
        for (Size size : sizes) if ((long) size.getWidth() * size.getHeight() < (long) smallest.getWidth() * smallest.getHeight()) smallest = size;
        return smallest;
    }

    // ---- Camera session (all on the capture thread) ----

    private void open(int width, int height, int fps) {
        final int attempt = ++generation;
        CameraManager manager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
        try {
            String id = null;
            for (String candidate : manager.getCameraIdList()) {
                Integer facing = manager.getCameraCharacteristics(candidate).get(CameraCharacteristics.LENS_FACING);
                boolean isFront = facing != null && facing == CameraMetadata.LENS_FACING_FRONT;
                if (isFront == wantFront) { id = candidate; break; }
                if (id == null) id = candidate;
            }
            if (id == null) { fail("no-camera", false); return; }
            CameraCharacteristics characteristics = manager.getCameraCharacteristics(id);
            Integer orientation = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION);
            Integer facing = characteristics.get(CameraCharacteristics.LENS_FACING);
            sensorOrientation = orientation == null ? 0 : orientation;
            front = facing != null && facing == CameraMetadata.LENS_FACING_FRONT;
            Range<Integer>[] ranges = characteristics.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
            Range<Integer> fpsRange = ranges == null || ranges.length == 0 ? null : pickFpsRange(ranges, fps);
            int factor = fpsRange != null && fpsRange.getUpper() > 1000 ? 1000 : 1;
            int streamFps = fpsRange == null ? fps : Math.min(fps, fpsRange.getUpper() / factor);
            StreamConfigurationMap map = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            Size size = map == null ? new Size(width, height) : pickSize(map, width, height, streamFps);
            helper.setTextureSize(size.getWidth(), size.getHeight());
            surface = new Surface(helper.getSurfaceTexture());
            String description = (front ? "front " : "back ") + size.getWidth() + "x" + size.getHeight()
                + " fps-range=" + (fpsRange == null ? "?" : (fpsRange.getLower() / factor) + "-" + (fpsRange.getUpper() / factor));
            manager.openCamera(id, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice device) {
                    if (attempt != generation) { device.close(); return; }
                    camera = device;
                    try {
                        device.createCaptureSession(Collections.singletonList(surface), new CameraCaptureSession.StateCallback() {
                            @Override public void onConfigured(CameraCaptureSession configured) {
                                if (attempt != generation) { configured.close(); device.close(); return; }
                                session = configured;
                                try {
                                    configured.setRepeatingRequest(buildRequest(device, characteristics, fpsRange), null, handler);
                                } catch (CameraAccessException | IllegalStateException | IllegalArgumentException e) {
                                    fail("request " + e.getClass().getSimpleName(), true);
                                    return;
                                }
                                running = true;
                                helper.startListening(frame -> {
                                    if (!running || attempt != generation) return;
                                    VideoFrame rotated = new VideoFrame(
                                        unmirror((TextureBufferImpl) frame.getBuffer(), front, -sensorOrientation),
                                        frameRotation(), frame.getTimestampNs());
                                    observer.onFrameCaptured(rotated);
                                    rotated.release();
                                });
                                observer.onCapturerStarted(true);
                                listener.onStarted(description);
                            }
                            @Override public void onConfigureFailed(CameraCaptureSession failed) {
                                failed.close();
                                if (attempt != generation) return;
                                fail("configure-failed", true);
                            }
                        }, handler);
                    } catch (CameraAccessException | IllegalStateException e) {
                        fail("session " + e.getClass().getSimpleName(), true);
                    }
                }
                @Override public void onDisconnected(CameraDevice device) {
                    device.close();
                    if (attempt != generation) return;
                    if (camera == device) camera = null;
                    fail("disconnected", true); // another app took the camera
                }
                @Override public void onError(CameraDevice device, int error) {
                    device.close();
                    if (attempt != generation) return;
                    if (camera == device) camera = null;
                    fail("error-" + error, error == ERROR_CAMERA_IN_USE || error == ERROR_MAX_CAMERAS_IN_USE || error == ERROR_CAMERA_DISABLED);
                }
            }, handler);
        } catch (CameraAccessException | SecurityException | IllegalArgumentException e) {
            fail("open " + e.getClass().getSimpleName(), true);
        }
    }

    private CaptureRequest buildRequest(CameraDevice device, CameraCharacteristics c, Range<Integer> fpsRange) throws CameraAccessException {
        CaptureRequest.Builder builder = device.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
        builder.addTarget(surface);
        builder.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO);
        builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
        builder.set(CaptureRequest.CONTROL_AE_LOCK, false);
        if (fpsRange != null) builder.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fpsRange);
        if (has(c.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES), CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO)) {
            builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO);
        }
        // Optical stabilisation is free; electronic stabilisation crops and adds latency.
        builder.set(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE, CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_OFF);
        if (has(c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION), CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_ON)) {
            builder.set(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE, CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_ON);
        }
        // HIGH_QUALITY processing modes are allowed to lower the frame rate; FAST ones are not.
        if (has(c.get(CameraCharacteristics.NOISE_REDUCTION_AVAILABLE_NOISE_REDUCTION_MODES), CaptureRequest.NOISE_REDUCTION_MODE_FAST)) {
            builder.set(CaptureRequest.NOISE_REDUCTION_MODE, CaptureRequest.NOISE_REDUCTION_MODE_FAST);
        }
        if (has(c.get(CameraCharacteristics.EDGE_AVAILABLE_EDGE_MODES), CaptureRequest.EDGE_MODE_FAST)) {
            builder.set(CaptureRequest.EDGE_MODE, CaptureRequest.EDGE_MODE_FAST);
        }
        if (has(c.get(CameraCharacteristics.COLOR_CORRECTION_AVAILABLE_ABERRATION_MODES), CaptureRequest.COLOR_CORRECTION_ABERRATION_MODE_FAST)) {
            builder.set(CaptureRequest.COLOR_CORRECTION_ABERRATION_MODE, CaptureRequest.COLOR_CORRECTION_ABERRATION_MODE_FAST);
        }
        return builder.build();
    }

    private static boolean has(int[] modes, int mode) {
        if (modes == null) return false;
        for (int m : modes) if (m == mode) return true;
        return false;
    }

    private void close() {
        generation++;
        running = false;
        if (helper != null) helper.stopListening();
        if (session != null) { try { session.close(); } catch (RuntimeException ignored) {} session = null; }
        if (camera != null) { try { camera.close(); } catch (RuntimeException ignored) {} camera = null; }
        if (surface != null) { surface.release(); surface = null; }
        if (observer != null) observer.onCapturerStopped();
    }

    private void fail(String reason, boolean busy) {
        boolean wasRunning = running;
        close();
        if (!wasRunning && observer != null) observer.onCapturerStarted(false);
        listener.onError(reason, busy);
    }

    /** Same as WebRTC Camera2Session: undo the OS front-camera mirror and the sensor rotation. */
    private static VideoFrame.TextureBuffer unmirror(TextureBufferImpl buffer, boolean mirror, int rotation) {
        Matrix matrix = new Matrix();
        matrix.preTranslate(0.5f, 0.5f);
        if (mirror) matrix.preScale(-1f, 1f);
        matrix.preRotate(rotation);
        matrix.preTranslate(-0.5f, -0.5f);
        return buffer.applyTransformMatrix(matrix, buffer.getWidth(), buffer.getHeight());
    }

    @SuppressWarnings("deprecation")
    private int frameRotation() {
        WindowManager wm = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        int device;
        switch (wm.getDefaultDisplay().getRotation()) {
            case Surface.ROTATION_90: device = 90; break;
            case Surface.ROTATION_180: device = 180; break;
            case Surface.ROTATION_270: device = 270; break;
            default: device = 0;
        }
        if (!front) device = 360 - device;
        return (sensorOrientation + device) % 360;
    }
}
