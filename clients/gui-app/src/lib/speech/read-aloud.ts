/**
 * Reads a reply aloud with the device's own speech engine.
 *
 * No audio or text may leave the device. Browsers list voices that synthesize
 * on a server next to on-device ones (Chrome's "Google ..." voices, Edge's
 * "Online (Natural)" voices), report them with `localService: false`, and may
 * make one the default. So an utterance is only ever spoken with an on-device
 * voice assigned explicitly, and nothing is spoken when the device has none.
 *
 * One reply plays at a time: the engine's queue is global, so starting a
 * reply cancels whatever is playing and the store below names the one reply
 * that owns the engine.
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

/**
 * The reply's prose as paragraphs to speak: fenced code blocks, link targets,
 * images, HTML tags and markdown markers are dropped.
 */
export function speakableParagraphs(markdown: string): string[] {
  const withoutFences = markdown.replace(
    /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm,
    "",
  );
  return withoutFences
    .split(/\n\s*\n/)
    .flatMap((block) =>
      block.split(/\n(?= {0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>))/),
    )
    .map((block) =>
      block
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]+>/g, "")
        .replace(/^ {0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
        .replace(/[`*_~|]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((paragraph) => paragraph.length > 0);
}

interface ActiveReading {
  readonly ownerId: string;
  readonly run: number;
}

let active: ActiveReading | null = null;
let runCounter = 0;
const listeners = new Set<() => void>();

function setActive(next: ActiveReading | null): void {
  active = next;
  for (const listener of listeners) listener();
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
  // An engine fires the cancelled run's end or error events late; only the
  // current run may clear the store.
  const finish = (): void => {
    if (active?.run === run) setActive(null);
  };
  setActive({ ownerId: input.ownerId, run });
  input.paragraphs.forEach((paragraph, index) => {
    const utterance = new SpeechSynthesisUtterance(paragraph);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.onerror = finish;
    if (index === input.paragraphs.length - 1) utterance.onend = finish;
    synth.speak(utterance);
  });
  return true;
}

export function stopReadingAloud(ownerId: string): void {
  if (active?.ownerId !== ownerId) return;
  setActive(null);
  deviceSpeechSynthesis()?.cancel();
}
