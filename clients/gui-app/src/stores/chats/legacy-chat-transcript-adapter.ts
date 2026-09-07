/**
 * The pre-windowed `chat.subscribe` transcript arm as a degenerate log adapter.
 * `chat.subscribe@1.8` gives the log replica an epoch, ordinals, bounded coverage and range reads.
 */
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type {
  AdapterDescriptor,
  AdapterDetachReason,
  AdapterHost,
  LaneAdapter,
  ResumeOffer,
} from "@traycer-clients/shared/replica-runtime";

export type LegacyChatSnapshotFrame = Parameters<
  ChatStreamCallbacks["onSnapshot"]
>[0];

export interface LegacyChatTranscriptSnapshotEvent {
  readonly kind: "legacy-unbounded-snapshot";
  /** The authority's complete transcript image. */
  readonly frame: LegacyChatSnapshotFrame;
}

export const LEGACY_CHAT_TRANSCRIPT_LANE_ID = "chat.subscribe@1.pre-windowed";

const LEGACY_CHAT_TRANSCRIPT_DESCRIPTOR: AdapterDescriptor = {
  laneId: LEGACY_CHAT_TRANSCRIPT_LANE_ID,
  kind: "legacy",
  label: "chat.subscribe@1.0-1.7 (unbounded transcript)",
};

/**
 * Decode arm fed by the multiplexed `ChatStreamClient` after its per-connection
 * manifest choice and schema parse have succeeded.
 */
export interface LegacyChatTranscriptAdapter extends LaneAdapter<LegacyChatTranscriptSnapshotEvent> {
  ingestSnapshot(frame: LegacyChatSnapshotFrame): void;
}

export function createLegacyChatTranscriptAdapter(): LegacyChatTranscriptAdapter {
  let host: AdapterHost<LegacyChatTranscriptSnapshotEvent> | null = null;
  let detached = false;

  return {
    descriptor: LEGACY_CHAT_TRANSCRIPT_DESCRIPTOR,

    attach(nextHost: AdapterHost<LegacyChatTranscriptSnapshotEvent>): void {
      if (detached) return;
      host = nextHost;
    },

    resumeOffer(): ResumeOffer {
      // The line has neither an epoch nor a position. A fabricated cursor would
      // license a resume comparison the authority cannot actually honour.
      return null;
    },

    detach(_reason: AdapterDetachReason): void {
      detached = true;
      host = null;
    },

    ingestSnapshot(frame: LegacyChatSnapshotFrame): void {
      host?.emit({ kind: "legacy-unbounded-snapshot", frame });
    },
  };
}
