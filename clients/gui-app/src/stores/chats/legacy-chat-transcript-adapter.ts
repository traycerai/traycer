/**
 * The pre-windowed `chat.subscribe` transcript arm as a degenerate log
 * adapter.
 *
 * `chat.subscribe@1.8` gives the log replica an epoch, ordinals, bounded
 * coverage and range reads. Earlier minors give it none of those: every
 * snapshot replaces the whole transcript and the client has to retain every
 * message and event it receives. Keeping that path behind the same adapter
 * seam makes the mixed fleet a capability choice rather than a second read
 * model.
 *
 * The physical `chat.subscribe` stream also multiplexes queue, turn,
 * approvals, worktree and live-delta frames. Its owner therefore keeps the
 * socket and feeds this adapter only the legacy snapshot callback. The stream's
 * shared generation guard remains outside this decode arm; duplicating it here
 * would create two generation books for one subscription.
 *
 * Honest degeneracies of this adapter:
 *
 * - no authority epoch and no cursor, so `resumeOffer()` is always `null`;
 * - no ordinals, so there is no range request or partial coverage;
 * - no bounded window, so every snapshot is a whole-transcript residency claim
 *   the process-wide memory accountant must measure at the consumer;
 * - replacement is wholesale: a later snapshot supersedes every previously
 *   retained transcript row.
 *
 * It implements no requester and never asks its host for replacement. The
 * adapter speaks for the authority, so it is structurally unable to originate
 * a client reseed.
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
  /**
   * The authority's complete transcript image. The consumer retains
   * `frame.snapshot.chat.messages` and `frame.snapshot.chat.events` in its
   * replica, so their full resident cost must be charged; this is never merely
   * a transient decode buffer.
   */
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
