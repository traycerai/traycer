import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  deviceSpeechSynthesis,
  pickOnDeviceVoice,
  readingOwnerId,
  speakableParagraphs,
  startReadingAloud,
  stopReadingAloud,
  subscribeReadAloud,
} from "@/lib/speech/read-aloud";

function preferredLanguage(): string {
  return typeof navigator === "undefined" ? "" : navigator.language;
}

function hasOnDeviceVoice(): boolean {
  const synth = deviceSpeechSynthesis();
  if (synth === null) return false;
  return pickOnDeviceVoice(synth.getVoices(), preferredLanguage()) !== null;
}

/**
 * Play/Stop state for reading one reply aloud. `available` is false where the
 * device has no speech engine or no on-device voice; voices can arrive after
 * the first render (`voiceschanged`), so it follows that event.
 */
export function useReadAloud(markdown: string): {
  readonly available: boolean;
  readonly reading: boolean;
  readonly toggle: () => void;
} {
  const ownerId = useId();
  const paragraphs = useMemo(() => speakableParagraphs(markdown), [markdown]);
  const [voiceReady, setVoiceReady] = useState(hasOnDeviceVoice);

  useEffect(() => {
    const synth = deviceSpeechSynthesis();
    if (synth === null) return undefined;
    const onVoicesChanged = (): void => setVoiceReady(hasOnDeviceVoice());
    onVoicesChanged();
    synth.addEventListener("voiceschanged", onVoicesChanged);
    return () => synth.removeEventListener("voiceschanged", onVoicesChanged);
  }, []);

  const reading = useSyncExternalStore(
    subscribeReadAloud,
    () => readingOwnerId() === ownerId,
    () => false,
  );

  useEffect(() => () => stopReadingAloud(ownerId), [ownerId]);

  const toggle = useCallback(() => {
    if (readingOwnerId() === ownerId) {
      stopReadingAloud(ownerId);
      return;
    }
    startReadingAloud({
      ownerId,
      paragraphs,
      preferredLanguage: preferredLanguage(),
    });
  }, [ownerId, paragraphs]);

  return {
    available: voiceReady && paragraphs.length > 0,
    reading,
    toggle,
  };
}
