/**
 * The page-side probe of `src/__tests__/browser/chat-send-follow.tsx` and the
 * frame recorders of the `chat-send-follow*.spec.ts` files. One ambient
 * declaration, so two specs never re-declare the same `Window` members with
 * different shapes. The names are distinct from `chat-send-owns-turn`'s.
 */
interface ChatFollowReading {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly distance: number;
  readonly mode: string | null;
  readonly pill: boolean;
  readonly dockHeight: number;
  readonly promptTop: number | null;
  readonly promptBottom: number | null;
  readonly rows: number;
  readonly lastRowKey: string | null;
}

interface ChatFollowFrame extends ChatFollowReading {
  readonly t: number;
  readonly step: string;
  /** Sum of the wheel deltaY events since the previous frame (0 when unused). */
  readonly wheel: number;
  /** Distance read at the start of the frame, before the rendering update (diagnostic). */
  readonly distanceA?: number;
}

interface ChatFollowDriver {
  readonly ready: boolean;
  readonly open: (
    kind: "idle" | "background-only" | "activating" | "running",
  ) => void;
  readonly lastMessageId: () => string | null;
  readonly probe: () => ChatFollowReading;
  readonly host: {
    readonly accept: (messageId: string) => void;
    readonly turnStarted: (messageId: string) => void;
    readonly queueAdded: (messageId: string) => void;
    readonly queueRemoved: () => void;
    readonly earlierTurnEnded: () => void;
    readonly streamReply: (tokens: number, intervalMs: number) => void;
    readonly stopReply: () => void;
    readonly streamRich: (
      prefix: string,
      cycles: number,
      intervalMs: number,
    ) => void;
    readonly streamBursty: (tokens: number, blockId: string) => void;
    readonly streamParts: (parts: number) => void;
  };
}

interface Window {
  __followDriver?: ChatFollowDriver;
  __followFrames?: ChatFollowFrame[];
  __followStep?: string;
  __followWheelAcc?: number;
  __followStop?: () => void;
}
