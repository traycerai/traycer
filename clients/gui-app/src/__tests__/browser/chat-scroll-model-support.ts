import type { SavedChatTabScrollState } from "@/stores/chats/chat-tab-state-cache";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import { TILE_KIND_BLANK } from "@/stores/epics/canvas/tile-kinds";

/**
 * What both lines of `chat-scroll-model.tsx` share: the chat's identity, the
 * tile-instance registration that makes an unmount read as a live tab's, and
 * the `window.__chatScrollProbe` contract the matrix specs drive.
 */
export const EPIC_ID = "chat-scroll-model";
export const TASK_ID = "chat-scroll-model-chat";

export type HideKind = "none" | "intact" | "collapse";

/** Registers the tile instance on a canvas, so an unmount reads as a live
 *  tab's (`isEpicCanvasTileInstanceLive`), not a close. */
export function setInstanceLive(instanceId: string, live: boolean): void {
  useEpicCanvasStore.setState((state) => {
    const canvas = createEmptyCanvas();
    return {
      canvasByTabId: {
        ...state.canvasByTabId,
        [EPIC_ID]: live
          ? {
              ...canvas,
              tilesByInstanceId: {
                [instanceId]: {
                  id: instanceId,
                  instanceId,
                  type: TILE_KIND_BLANK,
                  name: "chat",
                  hostId: "host",
                },
              },
            }
          : canvas,
      },
    };
  });
}

export function scrollNode(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-testid="chat-messages-scroll"]',
  );
}

interface ChatScrollGeometry {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export function readGeometry(): ChatScrollGeometry | null {
  const node = scrollNode();
  if (node === null) return null;
  return {
    scrollTop: node.scrollTop,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
  };
}

export function readPillShown(): boolean {
  const pill = document.querySelector('[aria-label="Scroll to end"]');
  return pill !== null && pill.getAttribute("aria-hidden") !== "true";
}

/** The windowed line's hydration, as ordinals. */
export interface HydratedRangeView {
  readonly rowCount: number;
  /** Each hydrated span, `[fromOrdinal, toOrdinal)`. */
  readonly spans: ReadonlyArray<{
    readonly fromOrdinal: number;
    readonly toOrdinal: number;
  }>;
  /** Records the host pushed whole that no span carries yet. */
  readonly liveMessageIds: ReadonlyArray<string>;
}

/** The session store's `transcriptWindow`, flattened for a failure message. */
export interface WindowStateView extends HydratedRangeView {
  readonly epoch: number;
  readonly indexRevision: number;
  readonly skeletonLength: number;
  readonly skeletonComplete: boolean;
  readonly skeletonStreamCoveredThrough: number;
  readonly invalidated: boolean;
  readonly staleSpans: ReadonlyArray<{
    readonly fromOrdinal: number;
    readonly toOrdinal: number;
  }>;
  /** The store's optimistic rows for sends the host has not accepted. */
  readonly pendingUserMessageIds: ReadonlyArray<string>;
  readonly activeTurnId: string | null;
  readonly runStatus: string;
}

export interface ChatScrollModelProbe {
  /** `legacy`: every row hydrated. `windowed`: production's line. */
  line: () => "legacy" | "windowed";
  /** One streamed token into the last reply. */
  grow: () => void;
  startStream: (intervalMs: number) => void;
  /** Streams a whole new paragraph per tick into the last reply. */
  startParagraphStream: (intervalMs: number) => void;
  stopStream: () => void;
  appendTurn: () => void;
  /** A turn whose reply opens with a collapsible reasoning card. */
  appendCardTurn: () => void;
  /** Like `appendCardTurn`, with five paragraphs above the card. */
  appendTallCardTurn: () => void;
  /** Prepends `paragraphs` paragraphs to the first text of a reply; legacy line only. */
  insertAboveInRow: (messageId: string, paragraphs: number) => void;
  hide: (kind: "intact" | "collapse") => void;
  show: () => void;
  /** `true`: the same tab instance mounts again (eviction). `false`: the
   *  tab closes and a new tab opens the chat. */
  remount: (sameInstance: boolean) => void;
  /** The turn outline's message ids, in the order `pick` takes. */
  pickItems: () => string[];
  /** A turn pick through the outline adapter (the phone's Messages list). */
  pick: (index: number) => void;
  geometry: () => ChatScrollGeometry | null;
  /** `following-end` | `free-scrolling` */
  mode: () => string | null;
  pillShown: () => boolean;
  /** A row's top relative to the scroll node's top, or null unmounted. On
   *  the windowed line a cold row's placeholder answers for it. */
  rowTop: (messageId: string) => number | null;
  /** The first row the reading line crosses, its top offset, and whether
   *  that row is a placeholder (always `false` on the legacy line). */
  readingRow: () => {
    messageId: string | null;
    offset: number;
    placeholder: boolean;
  } | null;
  saved: () => SavedChatTabScrollState | null;
  instanceId: () => string;
  /** `true` a placeholder, `false` hydrated, `null` not mounted. */
  isPlaceholder: (messageId: string) => boolean | null;
  /** `null` on the legacy line. */
  hydratedRange: () => HydratedRangeView | null;
  /** The row's ordinal in the host's index; `null` on the legacy line. */
  ordinalOf: (messageId: string) => number | null;
  /** How long the host takes to answer a range. Windowed line only. */
  setHydrationLatency: (ms: number) => void;
  /** Runs production's memory-pressure eviction over the chat's window:
   *  every span the viewport does not protect goes back to placeholders.
   *  Windowed line only. */
  evictCold: () => void;
  /** `null` on the legacy line. */
  windowState: () => WindowStateView | null;
  /** Every host frame and client request so far, timestamped. Windowed line
   *  only (empty on the legacy line). */
  frameLog: () => string[];
  /** The draft grows to this many lines, and the composer dock with it
   *  (130px at one line, 173px at eight). Windowed line only. */
  typeDraft: (lines: number) => void;
  /** The person presses Enter: the store's own send, and the dock returns
   *  to one line a frame later. Returns the message id. Windowed line only. */
  send: (text: string) => string;
  /** The host acks and accepts the oldest unaccepted send, as it broadcasts
   *  an append, and starts its turn. Windowed line only. */
  hostAccept: () => void;
  /** The host writes the running turn's assistant record, with what has
   *  streamed so far. A stream before it reaches only the live reply.
   *  Windowed line only. */
  assistantStarts: () => void;
  /** The host completes the running turn. Windowed line only. */
  finishTurn: () => void;
}

declare global {
  interface Window {
    __chatScrollProbe: ChatScrollModelProbe;
  }
}
