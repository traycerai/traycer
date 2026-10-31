package com.traycer.app;

import android.Manifest;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
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
 * setLive(true) takes transient audio focus for voice communication, which
 * pauses other apps' playback for the session; losing that focus to a call,
 * an alarm or another app's playback raises `interrupted`, and the voice
 * session ends. A ducking loss (a notification sound) is not an
 * interruption. setLive(false) gives the focus back.
 */
@CapacitorPlugin(
    name = "VoiceAudio",
    permissions = { @Permission(alias = VoiceAudioPlugin.MICROPHONE, strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class VoiceAudioPlugin extends Plugin {
    static final String MICROPHONE = "microphone";

    private AudioFocusRequest focusRequest;

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
        if (audio == null) {
            call.resolve();
            return;
        }
        if (!live) {
            releaseFocus(audio);
            call.resolve();
            return;
        }
        if (focusRequest == null) {
            AudioAttributes attributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();
            AudioFocusRequest request = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(attributes)
                .setOnAudioFocusChangeListener(this::onFocusChange)
                .build();
            focusRequest = request;
            // Refused while a call holds the audio: the session cannot be heard.
            if (audio.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_FAILED) {
                focusRequest = null;
                notifyListeners("interrupted", new JSObject());
            }
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        AudioManager audio = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (audio != null) releaseFocus(audio);
        super.handleOnDestroy();
    }

    private void onFocusChange(int change) {
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            notifyListeners("interrupted", new JSObject());
        }
    }

    private void releaseFocus(AudioManager audio) {
        if (focusRequest == null) return;
        audio.abandonAudioFocusRequest(focusRequest);
        focusRequest = null;
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
