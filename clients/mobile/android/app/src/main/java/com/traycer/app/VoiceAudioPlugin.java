package com.traycer.app;

import android.Manifest;
import android.content.Context;
import android.media.AudioManager;
import android.os.Build;
import androidx.annotation.RequiresApi;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * The phone's microphone permission and its voice session's interruptions
 * (see src/voice-audio.ts). The capture itself is the web view's: its
 * getUserMedia reaches Capacitor's onPermissionRequest, which grants audio
 * capture once RECORD_AUDIO is held, so asking here first is what lets the
 * app tell a refusal apart from a microphone that failed to open.
 *
 * checkMicrophone reads the decision without asking. requestMicrophone
 * raises the system dialog when the OS will still show it and answers the
 * remembered refusal otherwise - after a second "Don't allow" Android never
 * asks again, and only the app's settings page repairs it.
 *
 * While setLive(true) holds, a call raises `interrupted` and the voice
 * session ends: the audio mode moving to ringing, a call or call screening
 * (API 31+, where the mode can be listened to; below that a call is not
 * noticed). The mode is watched rather than audio focus on purpose: the web
 * view's own playback can move focus, which must never end the session, and
 * the communication mode the web view's call audio sets is the session's own.
 */
@CapacitorPlugin(
    name = "VoiceAudio",
    permissions = { @Permission(alias = VoiceAudioPlugin.MICROPHONE, strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class VoiceAudioPlugin extends Plugin {
    static final String MICROPHONE = "microphone";

    /** An AudioManager.OnModeChangedListener while live; typed loosely because that interface is API 31 and minSdk is 26. */
    private Object modeListener;

    @PluginMethod
    public void checkMicrophone(PluginCall call) {
        resolveState(call, stateName(getPermissionState(MICROPHONE)));
    }

    @PluginMethod
    public void requestMicrophone(PluginCall call) {
        PermissionState state = getPermissionState(MICROPHONE);
        if (state == PermissionState.GRANTED || state == PermissionState.DENIED) {
            resolveState(call, stateName(state));
            return;
        }
        requestPermissionForAlias(MICROPHONE, call, "microphoneDecided");
    }

    @PermissionCallback
    private void microphoneDecided(PluginCall call) {
        resolveState(call, getPermissionState(MICROPHONE) == PermissionState.GRANTED ? "granted" : "denied");
    }

    @PluginMethod
    public void setLive(PluginCall call) {
        boolean live = Boolean.TRUE.equals(call.getBoolean("live", false));
        AudioManager audio = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (audio == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            call.resolve();
            return;
        }
        if (!live) {
            stopWatching(audio);
            call.resolve();
            return;
        }
        if (modeListener == null) {
            AudioManager.OnModeChangedListener listener = (mode) -> {
                if (isCallMode(mode)) notifyListeners("interrupted", new JSObject());
            };
            modeListener = listener;
            audio.addOnModeChangedListener(getContext().getMainExecutor(), listener);
            // Started during a call: the session could not be heard.
            if (isCallMode(audio.getMode())) notifyListeners("interrupted", new JSObject());
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        AudioManager audio = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (audio != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) stopWatching(audio);
        super.handleOnDestroy();
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private void stopWatching(AudioManager audio) {
        if (modeListener == null) return;
        audio.removeOnModeChangedListener((AudioManager.OnModeChangedListener) modeListener);
        modeListener = null;
    }

    private static boolean isCallMode(int mode) {
        return (
            mode == AudioManager.MODE_RINGTONE ||
            mode == AudioManager.MODE_IN_CALL ||
            mode == AudioManager.MODE_CALL_SCREENING ||
            mode == AudioManager.MODE_CALL_REDIRECT
        );
    }

    private static String stateName(PermissionState state) {
        if (state == PermissionState.GRANTED) return "granted";
        if (state == PermissionState.DENIED) return "denied";
        return "prompt";
    }

    private static void resolveState(PluginCall call, String state) {
        JSObject result = new JSObject();
        result.put("state", state);
        call.resolve(result);
    }
}
