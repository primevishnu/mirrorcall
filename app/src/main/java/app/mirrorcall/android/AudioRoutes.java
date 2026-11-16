package app.mirrorcall.android;

import android.content.Context;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import org.json.JSONArray;
import org.json.JSONObject;

/** Event-driven output selection. No capture, DSP, encoder or periodic work lives here. */
final class AudioRoutes {
    interface Listener { void changed(String snapshot, boolean earpiece); }
    private final Context context;
    private final AudioManager audio;
    private final Listener listener;
    private boolean active, preferSpeaker = true;
    private Integer selectedId;
    private Api31 api31;
    private final AudioDeviceCallback devices = new AudioDeviceCallback() {
        @Override public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
            if (!active) return;
            if (selectedId == null && containsHeadset(added)) chooseDefault(false);
            else publish();
        }
        @Override public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
            if (!active) return;
            if (selectedId != null && find(selectedId) == null) { selectedId = null; chooseDefault(!hasHeadset()); }
            else if (selectedId == null && containsHeadset(removed) && !hasHeadset()) chooseDefault(true);
            else publish();
        }
    };

    AudioRoutes(Context context, AudioManager audio, Listener listener) { this.context = context; this.audio = audio; this.listener = listener; }
    private static boolean headset(int type) {
        return type == AudioDeviceInfo.TYPE_WIRED_HEADSET || type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
            || type == AudioDeviceInfo.TYPE_USB_HEADSET || type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
            || (Build.VERSION.SDK_INT >= 31 && type == AudioDeviceInfo.TYPE_BLE_HEADSET);
    }
    private static boolean containsHeadset(AudioDeviceInfo[] list) { for (AudioDeviceInfo d : list) if (headset(d.getType())) return true; return false; }
    private AudioDeviceInfo[] available() {
        return Build.VERSION.SDK_INT >= 31 ? audio.getAvailableCommunicationDevices().toArray(new AudioDeviceInfo[0]) : audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
    }
    boolean hasHeadset() { return containsHeadset(available()); }
    private AudioDeviceInfo find(int id) { for (AudioDeviceInfo d : available()) if (d.getId() == id) return d; return null; }
    private static String name(AudioDeviceInfo d) {
        if (d.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) return "Speaker";
        if (d.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) return "Phone earpiece";
        String product = String.valueOf(d.getProductName()).trim();
        return product.isEmpty() ? "Headset" : product.substring(0, Math.min(60, product.length()));
    }
    void start() {
        if (active) return;
        active = true; selectedId = null;
        audio.registerAudioDeviceCallback(devices, null);
        if (Build.VERSION.SDK_INT >= 31) api31 = new Api31();
        chooseDefault(!hasHeadset());
    }
    @SuppressWarnings("deprecation") void stop() {
        active = false; selectedId = null;
        audio.unregisterAudioDeviceCallback(devices);
        if (api31 != null) { api31.close(); api31 = null; }
        if (Build.VERSION.SDK_INT >= 31) audio.clearCommunicationDevice();
        else audio.setSpeakerphoneOn(false);
    }
    @SuppressWarnings("deprecation") void chooseDefault(boolean speaker) {
        if (!active) return;
        selectedId = null; preferSpeaker = speaker;
        if (Build.VERSION.SDK_INT >= 31) {
            AudioDeviceInfo chosen = null;
            for (AudioDeviceInfo d : available()) {
                if (speaker && d.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) { chosen = d; break; }
                if (!speaker && headset(d.getType())) { chosen = d; break; }
                if (!speaker && d.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) chosen = d;
            }
            if (chosen != null) audio.setCommunicationDevice(chosen);
        } else audio.setSpeakerphoneOn(speaker);
        publish(); // Report what Android actually selected, not the requested route.
    }
    boolean select(int id) {
        if (!active) return false;
        if (Build.VERSION.SDK_INT < 31) { if (id != -1 && id != -2) return false; chooseDefault(id == -1); return true; }
        AudioDeviceInfo d = find(id);
        if (d == null || !audio.setCommunicationDevice(d)) return false;
        selectedId = id;
        publish();
        return true;
    }
    void restore() {
        if (!active) return;
        if (selectedId != null) { int id = selectedId; if (select(id)) return; }
        chooseDefault(preferSpeaker);
    }
    @SuppressWarnings("deprecation") String snapshot() {
        JSONObject result = new JSONObject(); JSONArray list = new JSONArray();
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                AudioDeviceInfo current = audio.getCommunicationDevice();
                result.put("label", current == null ? "System default" : name(current));
                result.put("speaker", current != null && current.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER);
                for (AudioDeviceInfo d : available()) list.put(new JSONObject().put("id", d.getId()).put("label", name(d)).put("selected", current != null && d.getId() == current.getId()));
            } else {
                boolean speaker = audio.isSpeakerphoneOn();
                result.put("label", speaker ? "Speaker" : "Phone / headset").put("speaker", speaker);
                list.put(new JSONObject().put("id", -1).put("label", "Speaker").put("selected", speaker));
                list.put(new JSONObject().put("id", -2).put("label", "Phone / headset").put("selected", !speaker));
                result.put("note", "Android selects the connected headset on this version.");
            }
            result.put("devices", list);
        } catch (Exception ignored) {}
        return result.toString();
    }
    void publish() {
        if (!active) return;
        boolean earpiece;
        if (Build.VERSION.SDK_INT >= 31) { AudioDeviceInfo d = audio.getCommunicationDevice(); earpiece = d != null && d.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE; }
        else earpiece = !audio.isSpeakerphoneOn() && !hasHeadset();
        listener.changed(snapshot(), earpiece);
    }
    // Loaded only on Android 12+; the older-device path does not resolve this listener API.
    @android.annotation.TargetApi(31)
    private final class Api31 {
        private final AudioManager.OnCommunicationDeviceChangedListener changed = device -> publish();
        Api31() { audio.addOnCommunicationDeviceChangedListener(context.getMainExecutor(), changed); }
        void close() { audio.removeOnCommunicationDeviceChangedListener(changed); }
    }
}
