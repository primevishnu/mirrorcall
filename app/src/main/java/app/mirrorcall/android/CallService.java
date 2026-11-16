package app.mirrorcall.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Keeps MirrorCall alive while a call is open and you briefly switch apps (for example to send
 * a code on WhatsApp). Without it, Android 15+ cuts the network of backgrounded apps and
 * aggressive battery managers may kill the app. The microphone type also lets your partner
 * keep hearing you while the app is in the background; the camera always pauses.
 */
public final class CallService extends Service {
    private static final String CHANNEL = "ongoing-call";

    static void start(Context context, boolean micOn, String token) {
        // A plain startService from the visible app avoids the startForegroundService deadline,
        // so a refused foreground promotion can never crash the app.
        try { context.startService(new Intent(context, CallService.class).putExtra("micOn", micOn).putExtra("token", token)); } catch (RuntimeException ignored) {}
    }

    static void stop(Context context) {
        try { context.stopService(new Intent(context, CallService.class)); } catch (RuntimeException ignored) {}
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || intent.getStringExtra("token") == null || intent.getStringExtra("token").isEmpty()) { stopSelf(); return START_NOT_STICKY; }
        try {
            boolean micOn = intent.getBooleanExtra("micOn", true);
            String token = intent.getStringExtra("token");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel channel = new NotificationChannel(CHANNEL, "Ongoing call", NotificationManager.IMPORTANCE_LOW);
                channel.setShowBadge(false);
                manager.createNotificationChannel(channel);
            }
            PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            int icon = getResources().getIdentifier("ic_call", "drawable", getPackageName());
            PendingIntent mute = MainActivity.callAction(this, 1, "mute", token);
            PendingIntent leave = MainActivity.callAction(this, 2, "leave", token);
            int micIcon = getResources().getIdentifier(micOn ? "ic_mic" : "ic_mic_off", "drawable", getPackageName());
            int leaveIcon = getResources().getIdentifier("ic_call_end", "drawable", getPackageName());
            Notification.Builder builder = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(icon != 0 ? icon : getApplicationInfo().icon)
                .setContentTitle("MirrorCall")
                .setContentText(micOn ? "Call in progress. Tap to return." : "Microphone muted. Tap to return.")
                .setContentIntent(open)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setCategory(Notification.CATEGORY_CALL)
                .addAction(new Notification.Action.Builder(micIcon, micOn ? "Mute" : "Unmute", mute).build());
            if (Build.VERSION.SDK_INT >= 31) builder.setStyle(Notification.CallStyle.forOngoingCall(new Person.Builder().setName("MirrorCall").build(), leave));
            else builder.addAction(new Notification.Action.Builder(leaveIcon, "Leave call", leave).build());
            Notification notification = builder.build();
            if (Build.VERSION.SDK_INT >= 30) startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            else startForeground(1, notification);
        } catch (RuntimeException refused) {
            MainActivity.nativeLog(this, "call-service-refused " + refused.getClass().getSimpleName());
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override public void onTaskRemoved(Intent rootIntent) { stopSelf(); }

    @Override public IBinder onBind(Intent intent) { return null; }
}
