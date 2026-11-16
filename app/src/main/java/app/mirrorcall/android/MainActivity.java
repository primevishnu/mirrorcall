package app.mirrorcall.android;

import android.Manifest;
import android.app.Activity;
import android.app.AppOpsManager;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.BroadcastReceiver;
import android.content.IntentFilter;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.Icon;
import android.util.Rational;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.view.View;
import android.view.accessibility.AccessibilityManager;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.window.OnBackInvokedDispatcher;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.security.KeyStore;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Locale;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String STORE_KEY = "mirrorcall.settings.v1";
    private static final int MAX_SHARE = 20000;
    private static final Set<String> ASSETS = new HashSet<>(Arrays.asList("index.html", "app.mjs", "engine.mjs", "health.mjs", "crypto.mjs", "styles.css", "icon.svg", "NOTICE.txt"));
    private WebView webView;
    private PermissionRequest pendingPermission;
    private AudioManager audio;
    private AudioFocusRequest focus;
    private volatile boolean activeCall;
    private boolean foreground;
    private boolean pageReady;
    private int previousMode;
    private String pendingInvite;
    private PowerManager.WakeLock proximityLock;
    private WifiManager.WifiLock wifiLock;
    private AudioRoutes routes;
    private AccessibilityManager accessibility;
    private final AccessibilityManager.TouchExplorationStateChangeListener accessibilityChanged = enabled -> runOnUiThread(() -> js("window.MirrorNative && window.MirrorNative.controlsChanged()"));
    private String pendingShared;
    private String callActionToken = "";
    private static final String PREFS = "private-settings";
    static final String PIP_ACTION = "app.mirrorcall.android.PIP_ACTION";
    private static final String PIP_PERMISSION = "app.mirrorcall.android.permission.PIP_ACTION";
    private NativeEngine engine;
    private NativeEngine.PermissionResult pendingMedia;
    private boolean pendingAudio, pendingVideo;
    private boolean pipEnabled, pipMic = true;
    private int pipWidth = 9, pipHeight = 16;
    private final BroadcastReceiver pipReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            String action = intent.getStringExtra("action");
            if (activeCall && callActionToken.equals(intent.getStringExtra("token")) && ("mute".equals(action) || "leave".equals(action))) js("window.MirrorNative && window.MirrorNative.pipAction(" + JSONObject.quote(action) + ")");
        }
    };
    static synchronized void nativeLog(Context context, String event) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String line = new SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(new Date()) + " native " + event;
        String log = prefs.getString("nativeLog", "") + line + "\n";
        if (log.length() > 6000) log = log.substring(log.length() - 6000);
        prefs.edit().putString("nativeLog", log).commit();
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        audio = (AudioManager) getSystemService(AUDIO_SERVICE);
        routes = new AudioRoutes(this, audio, (snapshot, earpiece) -> {
            setProximity(activeCall && earpiece);
            js("window.MirrorNative && window.MirrorNative.audioRoutes(" + snapshot + ")");
        });
        accessibility = (AccessibilityManager) getSystemService(ACCESSIBILITY_SERVICE);
        if (accessibility != null) accessibility.addTouchExplorationStateChangeListener(accessibilityChanged);
        setVolumeControlStream(AudioManager.STREAM_VOICE_CALL);
        // Only test builds (debuggable) allow inspecting the page; release builds never do.
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        webView = new WebView(this);
        webView.setBackgroundColor(Color.TRANSPARENT); // native video shows through transparent page regions
        engine = new NativeEngine(this, new NativeEngine.Host() {
            @Override public void emit(String json) { runOnUiThread(() -> js("window.MirrorNative && window.MirrorNative.engine(" + JSONObject.quote(json) + ")")); }
            @Override public void requestPermissions(boolean audio, boolean video, NativeEngine.PermissionResult result) { runOnUiThread(() -> requestMedia(audio, video, result)); }
            @Override public void onRemoteVideoSize(int width, int height) { pipWidth = width; pipHeight = height; updatePip(); }
        });
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setSupportMultipleWindows(false);
        webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        webView.addJavascriptInterface(new Bridge(), "Android");
        webView.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!"https".equals(uri.getScheme()) || !"appassets.androidplatform.net".equals(uri.getHost())) return null;
                String name = uri.getPath() == null ? "" : uri.getPath().replaceFirst("^/", "");
                if (name.isEmpty()) name = "index.html";
                if (!ASSETS.contains(name)) return response(404, "Not Found", "text/plain", new ByteArrayInputStream(new byte[0]));
                String mime = name.endsWith(".mjs") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".svg") ? "image/svg+xml" : name.endsWith(".txt") ? "text/plain" : "text/html";
                try { return response(200, "OK", mime, getAssets().open(name)); }
                catch (IOException error) { return response(404, "Not Found", "text/plain", new ByteArrayInputStream(new byte[0])); }
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // Without this, Android kills the whole app when the web engine crashes.
                nativeLog(MainActivity.this, "web-engine-gone crashed=" + detail.didCrash() + " priority=" + detail.rendererPriorityAtExit() + " inCall=" + activeCall);
                if (view == webView) { webView = null; pageReady = false; }
                view.destroy();
                setCallState(false);
                Toast.makeText(MainActivity.this, "MirrorCall restarted after a problem. Please start the call again.", Toast.LENGTH_LONG).show();
                recreate();
                return true;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                return !("https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost()) && uri.getPort() == -1);
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> handleMediaPermission(request));
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingPermission == request) pendingPermission = null;
            }
        });
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF111218);
        root.addView(engine.bottomView, new FrameLayout.LayoutParams(0, 0));
        root.addView(engine.topView, new FrameLayout.LayoutParams(0, 0));
        root.addView(webView, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        IntentFilter pipFilter = new IntentFilter(PIP_ACTION);
        pipFilter.addDataScheme("mirrorcall-action");
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(pipReceiver, pipFilter, PIP_PERMISSION, null, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(pipReceiver, pipFilter, PIP_PERMISSION, null);
        if (Build.VERSION.SDK_INT >= 35) { // edge-to-edge is enforced from Android 15 for apps targeting 35+
            root.setOnApplyWindowInsetsListener((View view, WindowInsets insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            });
        }
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
        captureInvite(getIntent());
        webView.loadUrl(ORIGIN + "/index.html");
    }

    private WebResourceResponse response(int code, String reason, String mime, java.io.InputStream body) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("X-Content-Type-Options", "nosniff");
        headers.put("Referrer-Policy", "no-referrer");
        headers.put("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src https: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        return new WebResourceResponse(mime, "UTF-8", code, reason, headers, body);
    }

    private void handleMediaPermission(PermissionRequest request) {
        String origin = request.getOrigin().toString();
        if (!origin.equals(ORIGIN) && !origin.equals(ORIGIN + "/")) { request.deny(); return; }
        List<String> needed = new ArrayList<>();
        for (String resource : request.getResources()) {
            String permission;
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) permission = Manifest.permission.CAMERA;
            else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) permission = Manifest.permission.RECORD_AUDIO;
            else { request.deny(); return; }
            if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) needed.add(permission);
        }
        if (needed.isEmpty()) { request.grant(request.getResources()); return; }
        if (pendingPermission != null) pendingPermission.deny();
        pendingPermission = request;
        requestPermissions(needed.toArray(new String[0]), 100);
    }

    private void requestMedia(boolean audio, boolean video, NativeEngine.PermissionResult result) {
        List<String> needed = new ArrayList<>();
        if (audio && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) needed.add(Manifest.permission.RECORD_AUDIO);
        if (video && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) needed.add(Manifest.permission.CAMERA);
        if (needed.isEmpty()) { result.done(true, true); return; }
        if (pendingMedia != null) pendingMedia.done(false, false);
        pendingMedia = result; pendingAudio = audio; pendingVideo = video;
        requestPermissions(needed.toArray(new String[0]), 102);
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == 102 && pendingMedia != null) {
            NativeEngine.PermissionResult result = pendingMedia;
            pendingMedia = null;
            result.done(!pendingAudio || checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED,
                !pendingVideo || checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED);
            return;
        }
        // Re-post the ongoing-call notification now that it is allowed to show.
        if (code == 101) { if (activeCall && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) CallService.start(this, pipMic, callActionToken); return; }
        if (code != 100 || pendingPermission == null) return;
        PermissionRequest request = pendingPermission;
        pendingPermission = null;
        boolean granted = results.length == permissions.length && results.length > 0;
        for (int i = 0; i < results.length; i++) {
            if (Manifest.permission.POST_NOTIFICATIONS.equals(permissions[i])) continue; // optional
            granted &= results[i] == PackageManager.PERMISSION_GRANTED;
        }
        if (granted) request.grant(request.getResources()); else request.deny();
    }

    private void js(String code) { if (webView != null && pageReady) webView.evaluateJavascript(code, null); }

    @Override protected void onStart() {
        super.onStart(); foreground = true;
        if (activeCall && focus != null) audio.requestAudioFocus(focus);
        js("window.MirrorNative && window.MirrorNative.lifecycle(true)");
    }
    private boolean pipSupported() {
        return getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
    }
    @SuppressWarnings("deprecation")
    private boolean pipAllowed() {
        if (!pipSupported()) return false;
        AppOpsManager ops = (AppOpsManager) getSystemService(APP_OPS_SERVICE);
        if (ops == null) return true;
        int mode = Build.VERSION.SDK_INT >= 29
            ? ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_PICTURE_IN_PICTURE, android.os.Process.myUid(), getPackageName())
            : ops.checkOpNoThrow(AppOpsManager.OPSTR_PICTURE_IN_PICTURE, android.os.Process.myUid(), getPackageName());
        return mode == AppOpsManager.MODE_ALLOWED;
    }
    static PendingIntent callAction(Context context, int code, String action, String token) {
        Intent intent = new Intent(PIP_ACTION).setPackage(context.getPackageName())
            .setData(Uri.parse("mirrorcall-action:" + token + ":" + action))
            .putExtra("action", action).putExtra("token", token);
        return PendingIntent.getBroadcast(context, code, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
    private RemoteAction pipButton(int code, String action, String icon, String title) {
        PendingIntent pending = callAction(this, code, action, callActionToken);
        int id = getResources().getIdentifier(icon, "drawable", getPackageName());
        return new RemoteAction(Icon.createWithResource(this, id != 0 ? id : getApplicationInfo().icon), title, title, pending);
    }
    private PictureInPictureParams pipParams() {
        // Android accepts aspect ratios between 1:2.39 and 2.39:1.
        double ratio = Math.max(1 / 2.39, Math.min(2.39, (double) pipWidth / Math.max(1, pipHeight)));
        ArrayList<RemoteAction> actions = new ArrayList<>();
        actions.add(pipButton(1, "mute", pipMic ? "ic_mic" : "ic_mic_off", pipMic ? "Mute" : "Unmute"));
        actions.add(pipButton(2, "leave", "ic_call_end", "Leave call"));
        PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder()
            .setAspectRatio(new Rational((int) Math.round(ratio * 1000), 1000))
            .setActions(actions);
        if (Build.VERSION.SDK_INT >= 31) builder.setAutoEnterEnabled(pipEnabled && activeCall);
        return builder.build();
    }
    private void updatePip() {
        if (!pipSupported()) return;
        try { setPictureInPictureParams(pipParams()); } catch (RuntimeException ignored) {}
    }
    private boolean enterPip() {
        if (!activeCall || !pipEnabled || !pipAllowed()) return false;
        try { return enterPictureInPictureMode(pipParams()); } catch (RuntimeException e) { return false; }
    }
    // Android 8–11: enter picture-in-picture when you press Home during a call (12+ does it automatically).
    @Override protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (Build.VERSION.SDK_INT < 31 && pipEnabled && activeCall) enterPip();
    }
    @Override public void onPictureInPictureModeChanged(boolean inPip, Configuration config) {
        super.onPictureInPictureModeChanged(inPip, config);
        nativeLog(this, "pip " + inPip);
        js("window.MirrorNative && window.MirrorNative.pip(" + inPip + ")");
    }

    @Override public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (activeCall && level != TRIM_MEMORY_UI_HIDDEN) nativeLog(this, "low-memory level=" + level);
    }
    @Override protected void onStop() {
        foreground = false;
        js("window.MirrorNative && window.MirrorNative.lifecycle(false)");
        super.onStop();
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); captureInvite(intent); deliverInvite(); }
    private void captureInvite(Intent intent) {
        if (intent == null) return;
        if (Intent.ACTION_SEND.equals(intent.getAction()) && "text/plain".equals(intent.getType())) {
            try {
                CharSequence shared = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
                if (shared != null && shared.length() <= MAX_SHARE) pendingShared = shared.toString();
                else Toast.makeText(this, "This shared text is missing or too large.", Toast.LENGTH_LONG).show();
            } catch (RuntimeException invalid) { Toast.makeText(this, "Could not read the shared text.", Toast.LENGTH_LONG).show(); }
            intent.removeExtra(Intent.EXTRA_TEXT);
        }
        Uri uri = intent.getData();
        if (uri != null && "mirrorcall".equals(uri.getScheme()) && "invite".equals(uri.getHost()) && uri.toString().length() < 4096) { pendingInvite = uri.toString(); intent.setData(null); }
    }
    private void deliverInvite() {
        if (!pageReady) return;
        if (pendingShared != null) {
            String value = pendingShared; pendingShared = null;
            js("window.MirrorNative.receiveSharedCode(" + JSONObject.quote(value) + ")");
        } else if (pendingInvite != null) {
            String value = pendingInvite; pendingInvite = null;
            js("window.MirrorNative.receiveInvite(" + JSONObject.quote(value) + ")");
        }
    }
    // Android only allows clipboard reads while the app has window focus, so check for a copied
    // reply code exactly when the user switches back from WhatsApp.
    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) js("window.MirrorNative && window.MirrorNative.focus()");
    }
    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() { handleBack(); } // Android 12L and older
    private void handleBack() {
        if (!pageReady) { finish(); return; }
        js("window.MirrorNative && window.MirrorNative.back()");
    }

    private void setCallState(boolean active) {
        if (active == activeCall) return;
        activeCall = active;
        if (active) {
            callActionToken = java.util.UUID.randomUUID().toString();
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            CallService.start(this, pipMic, callActionToken);
            previousMode = audio.getMode();
            audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
            AudioAttributes attributes = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
            focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(attributes).setOnAudioFocusChangeListener(change -> {
                // A transient loss is a phone call or alarm: mute the microphone until it ends.
                // A permanent loss (another app started playing) does not interrupt the call.
                nativeLog(MainActivity.this, "audio-focus " + change);
                if (change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) js("window.MirrorNative && window.MirrorNative.interrupted(true)");
                else if (change == AudioManager.AUDIOFOCUS_GAIN) js("window.MirrorNative && window.MirrorNative.interrupted(false)");
            }).build();
            audio.requestAudioFocus(focus);
            routes.start();
            // Keep Wi-Fi out of power-save during the call: fewer late packets, less stutter.
            WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            if (wifi != null && wifiLock == null) {
                @SuppressWarnings("deprecation") int mode = Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                wifiLock = wifi.createWifiLock(mode, "MirrorCall:call");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
            SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if (Build.VERSION.SDK_INT >= 33 && !prefs.getBoolean("askedNotifications", false) && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                prefs.edit().putBoolean("askedNotifications", true).apply();
                requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 101);
            }
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            CallService.stop(this);
            pipEnabled = false;
            updatePip();
            if (isInPictureInPictureMode()) moveTaskToBack(false); // the call ended inside the floating window
            routes.stop();
            callActionToken = "";
            if (wifiLock != null) { if (wifiLock.isHeld()) wifiLock.release(); wifiLock = null; }
            setProximity(false);
            audio.setMode(previousMode);
            if (focus != null) audio.abandonAudioFocusRequest(focus);
            focus = null;
        }
    }
    private boolean headsetConnected() { return routes.hasHeadset(); }
    private void routeSpeaker(boolean speaker) { routes.chooseDefault(speaker); }
    // Turns the screen off while the phone is held to the ear, so a cheek cannot press buttons.
    private void setProximity(boolean on) {
        if (on && proximityLock == null) {
            PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
            if (power == null || !power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return;
            proximityLock = power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "MirrorCall:earpiece");
            proximityLock.acquire(4 * 60 * 60 * 1000L);
        } else if (!on && proximityLock != null) {
            if (proximityLock.isHeld()) proximityLock.release();
            proximityLock = null;
        }
    }
    @Override protected void onDestroy() {
        setCallState(false);
        if (accessibility != null) accessibility.removeTouchExplorationStateChangeListener(accessibilityChanged);
        try { unregisterReceiver(pipReceiver); } catch (IllegalArgumentException ignored) {}
        if (engine != null) { engine.dispose(); engine = null; }
        if (pendingPermission != null) pendingPermission.deny();
        if (webView != null) { webView.removeJavascriptInterface("Android"); webView.destroy(); webView = null; }
        super.onDestroy();
    }

    private SecretKey storageKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(STORE_KEY)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(STORE_KEY, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(STORE_KEY, null);
    }
    private final class Bridge {
        @JavascriptInterface public String getSettings() {
            try {
                SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                String stored = prefs.getString("config", null);
                if (stored == null) return "{}";
                String[] parts = stored.split(":", 2);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, storageKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
                return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), "UTF-8");
            } catch (Exception error) { return "{}"; }
        }
        @JavascriptInterface public void saveSettings(String value) {
            if (value == null || value.length() > 8192) return;
            try {
                new JSONObject(value);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, storageKey());
                String stored = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(cipher.doFinal(value.getBytes("UTF-8")), Base64.NO_WRAP);
                getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("config", stored).apply();
            } catch (Exception error) { runOnUiThread(() -> Toast.makeText(MainActivity.this, "Could not save settings securely. Please try again.", Toast.LENGTH_LONG).show()); }
        }
        @JavascriptInterface public void ready() { runOnUiThread(() -> { pageReady = true; deliverInvite(); if (!foreground) js("window.MirrorNative.lifecycle(false)"); }); }
        @JavascriptInterface public void setCallActive(boolean active) { runOnUiThread(() -> setCallState(active)); }
        @JavascriptInterface public void setSpeaker(boolean enabled) { runOnUiThread(() -> routeSpeaker(enabled)); }
        @JavascriptInterface public boolean hasHeadset() { return headsetConnected(); }
        @JavascriptInterface public void engine(String json) { NativeEngine current = engine; if (current != null && json != null && json.length() < 200_000) current.handle(json); }
        @JavascriptInterface public void setPipEnabled(boolean enabled) { runOnUiThread(() -> { pipEnabled = enabled; updatePip(); }); }
        @JavascriptInterface public void setPipMic(boolean on) { runOnUiThread(() -> { if (pipMic == on) return; pipMic = on; updatePip(); if (activeCall) CallService.start(MainActivity.this, pipMic, callActionToken); }); }
        @JavascriptInterface public void setPipAspect(int width, int height) { if (width > 0 && height > 0) runOnUiThread(() -> { pipWidth = width; pipHeight = height; updatePip(); }); }
        @JavascriptInterface public boolean enterPip() {
            boolean allowed = pipAllowed();
            if (allowed) runOnUiThread(MainActivity.this::enterPip);
            return allowed;
        }
        @JavascriptInterface public boolean isTouchExplorationEnabled() { return accessibility != null && accessibility.isTouchExplorationEnabled(); }
        @JavascriptInterface public int recommendedControlsTimeout(int millis) {
            int base = Math.max(4000, Math.min(millis, 8000));
            return Build.VERSION.SDK_INT >= 29 && accessibility != null
                ? accessibility.getRecommendedTimeoutMillis(base, AccessibilityManager.FLAG_CONTENT_CONTROLS | AccessibilityManager.FLAG_CONTENT_TEXT) : base;
        }
        @JavascriptInterface public String getAudioRoutes() { return routes.snapshot(); }
        @JavascriptInterface public void selectAudioRoute(int id) {
            runOnUiThread(() -> {
                if (!activeCall) return;
                if (!routes.select(id)) js("window.MirrorNative && window.MirrorNative.audioRouteError()");
                routes.publish();
            });
        }
        @JavascriptInterface public void restoreAudioRoute() { runOnUiThread(() -> routes.restore()); }
        @JavascriptInterface public String takeEvents() {
            SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String log = prefs.getString("nativeLog", "");
            prefs.edit().remove("nativeLog").apply();
            return log;
        }
        @JavascriptInterface public String deviceInfo() {
            String app = "?", web = "?";
            try { app = getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception ignored) {}
            PackageInfo engine = WebView.getCurrentWebViewPackage();
            if (engine != null) web = engine.packageName + " " + engine.versionName;
            return "MirrorCall " + app + " · " + Build.MANUFACTURER + " " + Build.MODEL + " · Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ") · " + web;
        }
        @JavascriptInterface public String readClipboard() {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (clipboard == null || !clipboard.hasPrimaryClip()) return "";
            ClipData clip = clipboard.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return "";
            CharSequence text = clip.getItemAt(0).coerceToText(MainActivity.this);
            return text == null || text.length() > MAX_SHARE ? "" : text.toString();
        }
        @JavascriptInterface public void copyText(String text) {
            if (text == null || text.length() > MAX_SHARE) return;
            runOnUiThread(() -> { ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE); ClipData clip = ClipData.newPlainText("MirrorCall code", text); if (Build.VERSION.SDK_INT >= 33) { android.os.PersistableBundle extras = new android.os.PersistableBundle(); extras.putBoolean("android.content.extra.IS_SENSITIVE", true); clip.getDescription().setExtras(extras); } clipboard.setPrimaryClip(clip); });
        }
        @JavascriptInterface public void shareInvite(String text) {
            if (text == null || text.length() > MAX_SHARE || !(text.startsWith("mirrorcall://invite#") || text.contains("MC1."))) return;
            runOnUiThread(() -> { Intent intent = new Intent(Intent.ACTION_SEND); intent.setType("text/plain"); intent.putExtra(Intent.EXTRA_SUBJECT, "MirrorCall code"); intent.putExtra(Intent.EXTRA_TEXT, text); startActivity(Intent.createChooser(intent, "Send to your person")); });
        }
        @JavascriptInterface public void closeApp() { runOnUiThread(() -> finish()); }
    }
}
