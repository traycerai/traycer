/**
 * Reads a reply aloud with the device's own speech engine.
 *
 * No audio or text may leave the device. Browsers list voices that synthesize
 * on a server next to on-device ones (Chrome's "Google ..." voices, Edge's
 * "Online (Natural)" voices), report them with `localService: false`, and may
 * make one the default. So an utterance is only ever spoken with an on-device
 * voice assigned explicitly, the voice is looked up again before each
 * paragraph is queued, and reading stops the moment that voice is gone.
 *
 * One reply plays at a time: the engine's queue is global, so starting a
 * reply cancels whatever is playing and the store below names the one reply
 * that owns the engine, with the conversation it belongs to.
 */

export function deviceSpeechSynthesis(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  if (!("speechSynthesis" in window)) return null;
  if (!("SpeechSynthesisUtterance" in window)) return null;
  return window.speechSynthesis;
}

export function pickOnDeviceVoice(
  voices: ReadonlyArray<SpeechSynthesisVoice>,
  preferredLanguage: string,
): SpeechSynthesisVoice | null {
  const onDevice = voices.filter((voice) => voice.localService);
  const language = preferredLanguage.toLowerCase().split("-")[0];
  return (
    onDevice.find((voice) => voice.default) ??
    onDevice.find(
      (voice) => voice.lang.toLowerCase().split(/[-_]/)[0] === language,
    ) ??
    onDevice.at(0) ??
    null
  );
}

interface ActiveReading {
  readonly ownerId: string;
  readonly conversation: string;
  readonly run: number;
  readonly voiceURI: string;
}

let active: ActiveReading | null = null;
let runCounter = 0;
const listeners = new Set<() => void>();
let watchedSynth: SpeechSynthesis | null = null;

function onDeviceVoiceFor(
  synth: SpeechSynthesis,
  reading: ActiveReading,
): SpeechSynthesisVoice | null {
  return (
    synth
      .getVoices()
      .find(
        (voice) => voice.localService && voice.voiceURI === reading.voiceURI,
      ) ?? null
  );
}

function onVoicesChanged(): void {
  const synth = watchedSynth;
  if (synth === null || active === null) return;
  if (onDeviceVoiceFor(synth, active) === null) endRun(active.run);
}

function setActive(next: ActiveReading | null): void {
  active = next;
  const synth = next === null ? null : deviceSpeechSynthesis();
  if (watchedSynth !== synth) {
    watchedSynth?.removeEventListener("voiceschanged", onVoicesChanged);
    synth?.addEventListener("voiceschanged", onVoicesChanged);
    watchedSynth = synth;
  }
  for (const listener of listeners) listener();
}

/**
 * Ends the run if it is still the current one, cancelling anything it queued.
 * An engine fires a cancelled run's events late, so a stale run is a no-op.
 */
function endRun(run: number): void {
  if (active?.run !== run) return;
  setActive(null);
  deviceSpeechSynthesis()?.cancel();
}

function speakParagraph(
  synth: SpeechSynthesis,
  run: number,
  paragraphs: ReadonlyArray<string>,
  index: number,
): void {
  if (active?.run !== run) return;
  const voice = onDeviceVoiceFor(synth, active);
  const paragraph = paragraphs.at(index);
  if (voice === null || paragraph === undefined) {
    endRun(run);
    return;
  }
  const utterance = new SpeechSynthesisUtterance(paragraph);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  utterance.onend = () => {
    if (index + 1 < paragraphs.length) {
      speakParagraph(synth, run, paragraphs, index + 1);
      return;
    }
    if (active?.run === run) setActive(null);
  };
  utterance.onerror = () => endRun(run);
  synth.speak(utterance);
}

export function subscribeReadAloud(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readingOwnerId(): string | null {
  return active?.ownerId ?? null;
}

/** Returns false, speaking nothing, when no on-device voice is available. */
export function startReadingAloud(input: {
  readonly ownerId: string;
  readonly conversation: string;
  readonly paragraphs: ReadonlyArray<string>;
  readonly preferredLanguage: string;
}): boolean {
  const synth = deviceSpeechSynthesis();
  if (synth === null || input.paragraphs.length === 0) return false;
  const voice = pickOnDeviceVoice(synth.getVoices(), input.preferredLanguage);
  if (voice === null) return false;

  synth.cancel();
  runCounter += 1;
  const run = runCounter;
  setActive({
    ownerId: input.ownerId,
    conversation: input.conversation,
    run,
    voiceURI: voice.voiceURI,
  });
  speakParagraph(synth, run, input.paragraphs, 0);
  return true;
}

export function stopReadingAloud(ownerId: string): void {
  if (active?.ownerId !== ownerId) return;
  endRun(active.run);
}

/** A new reply arrived in `conversation`: stop reading an older one there. */
export function stopReadingInConversation(conversation: string): void {
  if (active?.conversation !== conversation) return;
  endRun(active.run);
}
