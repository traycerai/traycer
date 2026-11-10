package com.traycer.app;

import android.content.Intent;
import android.media.AudioFormat;
import android.os.Build;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.speech.RecognitionListener;
import android.speech.RecognitionSupport;
import android.speech.RecognitionSupportCallback;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Base64;
import androidx.annotation.RequiresApi;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Dictation transcribed by the phone's own recognizer (see
 * src/device-dictation.ts). The web view captures the microphone and sends
 * the audio here, which is piped to the recognizer as its audio source, so
 * nothing in this file opens a microphone.
 *
 * Only the on-device recognizer is ever created, so audio is never sent to a
 * server. It exists from Android 13, where a recognizer can be handed its
 * audio; below that dictation is unavailable.
 *
 * A language the device supports but has not installed is offered: the first
 * start raises the system's own download dialog and fails, and dictation
 * works once the person has accepted it.
 *
 * The recognizer reports what was said before a pause only as partial
 * results, never as a result of its own, so the last partial of an utterance
 * is its transcript: it is raised as `transcript` when the next utterance
 * begins, and the final one is `finish`'s answer.
 */
@CapacitorPlugin(name = "DeviceDictation")
public class DeviceDictationPlugin extends Plugin {
    private static final String LANGUAGE_NOT_INSTALLED = "LANGUAGE_NOT_INSTALLED";

    /** One dictation. Every field is read and written on the main thread, except the pipe, which its writer thread owns. */
    private static final class Session {
        final String id;
        final Intent intent;
        /** The pipe's read end, held only until the recognizer has its own copy. */
        final ParcelFileDescriptor source;
        final OutputStream pipe;
        final ExecutorService writer = Executors.newSingleThreadExecutor();
        boolean listening;
        boolean audioEnded;
        /** The current utterance's latest partial result. */
        String pending = "";
        String failure;
        /** Set once the recognizer has nothing more to say. */
        boolean ended;
        PluginCall finishCall;

        Session(String id, Intent intent, ParcelFileDescriptor source, OutputStream pipe) {
            this.id = id;
            this.intent = intent;
            this.source = source;
            this.pipe = pipe;
        }
    }

    private Session session;

    /**
     * The start still waiting on its language check. Only the latest start
     * may open a session, and a cancel withdraws it, so an answer that
     * arrives late or out of order never replaces a newer session.
     */
    private String startingId;

    /**
     * The one recognizer behind every language check, language download and
     * session, created on first use and kept. All of an app's recognizers
     * share one connection to the system, and destroying one that is not
     * listening closes it for the others, so a request made around a destroy
     * can be lost. It is destroyed only once it has failed, to be replaced
     * by a new one on the next use.
     */
    private SpeechRecognizer recognizer;

    @PluginMethod
    public void isAvailable(PluginCall call) {
        String language = call.getString("language", "auto");
        resolveLanguage(language, (tag, installed) -> {
            JSObject result = new JSObject();
            result.put("available", tag != null);
            call.resolve(result);
            return false;
        });
    }

    @PluginMethod
    public void start(PluginCall call) {
        String id = call.getString("sessionId");
        Integer sampleRate = call.getInt("sampleRate");
        if (id == null || sampleRate == null) {
            call.reject("Dictation could not start.");
            return;
        }
        String language = call.getString("language", "auto");
        getActivity().runOnUiThread(() -> {
            startingId = id;
            resolveLanguage(language, (tag, installed) -> open(call, id, sampleRate, tag, installed));
        });
    }

    /**
     * Opens the session a start asked for, once its language is known.
     * Returns whether the language should be downloaded instead.
     */
    private boolean open(PluginCall call, String id, int sampleRate, String tag, boolean installed) {
        if (!id.equals(startingId)) {
            call.reject("Dictation was cancelled.");
            return false;
        }
        startingId = null;
        if (tag == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            call.reject("Dictation is not available on this device.");
            return false;
        }
        if (!installed) {
            call.reject("Download the language to dictate, then try again.", LANGUAGE_NOT_INSTALLED);
            return true;
        }
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, tag);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        end(session, "Dictation was replaced.");
        try {
            session = open(id, intent, sampleRate);
        } catch (IOException | RuntimeException error) {
            // The recognizer can be gone between the support check and here.
            call.reject("Dictation could not start.");
            return false;
        }
        call.resolve();
        return false;
    }

    @PluginMethod
    public void appendAudio(PluginCall call) {
        String id = call.getString("sessionId");
        String audio = call.getString("audio");
        if (id == null || audio == null) {
            call.reject("Dictation audio was not readable.");
            return;
        }
        byte[] pcm = Base64.decode(audio, Base64.DEFAULT);
        getActivity().runOnUiThread(() -> {
            Session current = session;
            if (current == null || !current.id.equals(id)) {
                call.resolve();
                return;
            }
            if (current.failure != null) {
                call.reject(current.failure);
                return;
            }
            // Listening starts with the first audio: by then the web view
            // holds the microphone permission the recognizer also checks.
            if (!current.listening) {
                current.listening = true;
                recognizer().startListening(current.intent);
            }
            current.writer.execute(() -> {
                try {
                    current.pipe.write(pcm);
                } catch (IOException error) {
                    // The recognizer closed its end; its listener reports why.
                }
            });
            call.resolve();
        });
    }

    @PluginMethod
    public void finish(PluginCall call) {
        String id = call.getString("sessionId");
        getActivity().runOnUiThread(() -> {
            Session current = session;
            if (current == null || !current.id.equals(id)) {
                call.reject("Dictation was not running.");
                return;
            }
            current.finishCall = call;
            if (!current.listening) {
                // No audio ever arrived, so there is nothing to transcribe.
                current.ended = true;
            } else if (current.failure == null) {
                current.audioEnded = true;
                closePipe(current);
            }
            settle(current);
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("sessionId");
        getActivity().runOnUiThread(() -> {
            if (id != null && id.equals(startingId)) startingId = null;
            if (session != null && session.id.equals(id)) end(session, "Dictation was cancelled.");
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        end(session, "Dictation was cancelled.");
        dropRecognizer();
    }

    private interface LanguageAnswer {
        /**
         * `tag` is null when the device cannot transcribe the language by
         * itself. Returns whether to ask the system to download a language
         * that is not installed.
         */
        boolean answer(String tag, boolean installed);
    }

    /**
     * Resolves the language the recognizer would transcribe by itself:
     * `"auto"` is the device's own language, and a language without the asked
     * region falls back to another region of the same language.
     */
    private void resolveLanguage(String language, LanguageAnswer answer) {
        getActivity().runOnUiThread(() -> {
            if (
                Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                !SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext())
            ) {
                answer.answer(null, false);
                return;
            }
            try {
                askSupport("auto".equals(language) ? Locale.getDefault().toLanguageTag() : language, answer);
            } catch (RuntimeException error) {
                // The recognizer went away after the check above.
                answer.answer(null, false);
            }
        });
    }

    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    private void askSupport(String wanted, LanguageAnswer answer) {
        SpeechRecognizer recognizer = recognizer();
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, wanted);
        recognizer.checkRecognitionSupport(
            intent,
            getContext().getMainExecutor(),
            new RecognitionSupportCallback() {
                @Override
                public void onSupportResult(RecognitionSupport support) {
                    String installed = match(wanted, support.getInstalledOnDeviceLanguages());
                    if (installed != null) {
                        answer.answer(installed, true);
                        return;
                    }
                    List<String> downloadable = new ArrayList<>(support.getSupportedOnDeviceLanguages());
                    downloadable.addAll(support.getPendingOnDeviceLanguages());
                    String tag = match(wanted, downloadable);
                    if (!answer.answer(tag, false) || tag == null) return;
                    Intent download = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                    download.putExtra(RecognizerIntent.EXTRA_LANGUAGE, tag);
                    recognizer.triggerModelDownload(download);
                }

                @Override
                public void onError(int error) {
                    if (session == null) dropRecognizer();
                    answer.answer(null, false);
                }
            }
        );
    }

    private static String match(String wanted, List<String> tags) {
        for (String tag : tags) {
            if (tag.equalsIgnoreCase(wanted)) return tag;
        }
        String language = Locale.forLanguageTag(wanted).getLanguage();
        for (String tag : tags) {
            if (Locale.forLanguageTag(tag).getLanguage().equals(language)) return tag;
        }
        return null;
    }

    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    private Session open(String id, Intent intent, int sampleRate) throws IOException {
        SpeechRecognizer recognizer = recognizer();
        ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
        intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pipe[0]);
        intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1);
        intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT);
        intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, sampleRate);
        // The session lasts as long as the audio does, through any pause.
        intent.putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE);
        Session opened = new Session(id, intent, pipe[0], new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]));
        recognizer.setRecognitionListener(
            new RecognitionListener() {
                @Override
                public void onBeginningOfSpeech() {
                    // A new utterance: the one before it is complete.
                    raisePending(opened);
                }

                @Override
                public void onPartialResults(Bundle results) {
                    opened.pending = first(results);
                }

                @Override
                public void onSegmentResults(Bundle results) {
                    String text = first(results);
                    if (!text.isEmpty()) opened.pending = text;
                    raisePending(opened);
                }

                @Override
                public void onEndOfSegmentedSession() {
                    opened.ended = true;
                    settle(opened);
                }

                @Override
                public void onResults(Bundle results) {
                    String text = first(results);
                    if (!text.isEmpty()) opened.pending = text;
                    opened.ended = true;
                    settle(opened);
                }

                @Override
                public void onError(int error) {
                    // Audio with no speech in it is an empty transcript, not
                    // a failed dictation.
                    boolean noSpeech = error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT;
                    if (opened.audioEnded && noSpeech) {
                        opened.ended = true;
                    } else {
                        opened.failure = "Dictation failed (" + error + ").";
                    }
                    settle(opened);
                }

                @Override
                public void onReadyForSpeech(Bundle params) {
                    // The recognizer reads its own copy from here on. With
                    // this one closed it is the only reader, so a write
                    // fails, and never blocks, once the recognizer is gone.
                    closeQuietly(opened.source);
                }

                @Override
                public void onRmsChanged(float rmsdB) {}

                @Override
                public void onBufferReceived(byte[] buffer) {}

                @Override
                public void onEndOfSpeech() {}

                @Override
                public void onEvent(int eventType, Bundle params) {}
            }
        );
        return opened;
    }

    private static String first(Bundle results) {
        ArrayList<String> texts = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return texts == null || texts.isEmpty() ? "" : texts.get(0).trim();
    }

    private void raisePending(Session current) {
        if (current != session || current.pending.isEmpty()) return;
        JSObject event = new JSObject();
        event.put("sessionId", current.id);
        event.put("text", current.pending);
        current.pending = "";
        notifyListeners("transcript", event);
    }

    /** Answers a pending `finish` once the recognizer has ended or failed. A failure before `finish` waits here: `appendAudio` reports it. */
    private void settle(Session current) {
        PluginCall call = current.finishCall;
        if (call == null || current != session) return;
        if (current.failure != null) {
            call.reject(current.failure);
        } else if (current.ended) {
            JSObject result = new JSObject();
            result.put("text", current.pending);
            call.resolve(result);
        } else {
            return;
        }
        current.finishCall = null;
        release(current);
    }

    private void end(Session current, String message) {
        if (current == null) return;
        if (current.finishCall != null) current.finishCall.reject(message);
        current.finishCall = null;
        if (current == session && current.listening && recognizer != null) recognizer.cancel();
        release(current);
    }

    /**
     * Frees the session at once: audio still queued for the pipe is dropped,
     * and a write blocked on a full pipe fails because both read ends close:
     * this one here, the recognizer's when it is cancelled or has ended.
     */
    private void release(Session current) {
        current.writer.shutdownNow();
        closeQuietly(current.source);
        try {
            current.pipe.close();
        } catch (IOException error) {
            // Already closed.
        }
        if (session != current) return;
        session = null;
        if (current.failure != null) dropRecognizer();
    }

    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    private SpeechRecognizer recognizer() {
        if (recognizer == null) recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(getContext());
        return recognizer;
    }

    private void dropRecognizer() {
        if (recognizer != null) recognizer.destroy();
        recognizer = null;
    }

    private static void closeQuietly(ParcelFileDescriptor descriptor) {
        try {
            descriptor.close();
        } catch (IOException error) {
            // Already closed.
        }
    }

    /** Closes after the audio already queued for the pipe has been written. */
    private void closePipe(Session current) {
        if (current.writer.isShutdown()) return;
        current.writer.execute(() -> {
            try {
                current.pipe.close();
            } catch (IOException error) {
                // Already closed by the recognizer.
            }
        });
    }
}
