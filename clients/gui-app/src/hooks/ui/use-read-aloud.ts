import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTileBodyVisible } from "@/components/epic-canvas/hooks/use-tile-body-visible";
import { markdownToSpokenParagraphs } from "@/markdown/spoken-paragraphs";
import {
  deviceSpeechSynthesis,
  pickOnDeviceVoice,
  readingOwnerId,
  startReadingAloud,
  stopReadingAloud,
  stopReadingInConversation,
  subscribeReadAloud,
} from "@/lib/speech/read-aloud";
import { useChatOpenStoreScope } from "@/stores/chats/open-store-scope";

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
 *
 * Reading stops when the reply unmounts, and also when it is concealed while
 * kept mounted: an epic pane or a canvas tab that is not in front keeps its
 * chat mounted under `display:none`, which would leave speech running with
 * its Stop control out of sight.
 */
export function useReadAloud(markdown: string): {
  readonly available: boolean;
  readonly reading: boolean;
  readonly toggle: () => void;
} {
  const ownerId = useId();
  const conversation = useChatOpenStoreScope();
  const shown = useTileBodyVisible();
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

  useEffect(() => {
    if (!shown) stopReadingAloud(ownerId);
  }, [ownerId, shown]);

  useEffect(() => () => stopReadingAloud(ownerId), [ownerId]);

  const toggle = useCallback(() => {
    if (readingOwnerId() === ownerId) {
      stopReadingAloud(ownerId);
      return;
    }
    // Parsed on Play, not per render: a reply re-renders often and can be
    // long, and its spoken text is needed only once it is played.
    startReadingAloud({
      ownerId,
      conversation,
      paragraphs: markdownToSpokenParagraphs(markdown),
      preferredLanguage: preferredLanguage(),
    });
  }, [conversation, markdown, ownerId]);

  return {
    available: voiceReady && markdown.trim().length > 0,
    reading,
    toggle,
  };
}

/**
 * Stops reading an older reply of `conversation` when its latest reply
 * changes. Kept at the transcript, which sees every row: the virtualized list
 * mounts only the rows near the viewport, so a row cannot tell that a newer
 * reply arrived.
 */
export function useStopReadingOnNewReply(
  conversation: string,
  latestReplyId: string | null,
): void {
  const previous = useRef(latestReplyId);
  useEffect(() => {
    if (previous.current === latestReplyId) return;
    previous.current = latestReplyId;
    stopReadingInConversation(conversation);
  }, [conversation, latestReplyId]);
}
