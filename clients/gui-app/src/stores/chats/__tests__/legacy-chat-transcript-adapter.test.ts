import { describe, expect, it } from "vitest";
import type {
  AdapterHost,
  AdapterStatus,
  ReplicaReplacementReason,
  ResumeOutcome,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import {
  createLegacyChatTranscriptAdapter,
  LEGACY_CHAT_TRANSCRIPT_LANE_ID,
  type LegacyChatSnapshotFrame,
  type LegacyChatTranscriptSnapshotEvent,
} from "../legacy-chat-transcript-adapter";

/**
 * `chat.subscribe@1.0-1.7` degenerate adapter - descriptor identity, honest
 * `resumeOffer(): null`, exact emission while attached, silence after
 * detach, and proof it never asks its host for a replacement.
 *
 * Mirrors `legacy-epic-stream-adapter.test.ts`'s seam: no socket, no store,
 * no projection - a fake `AdapterHost` recording exactly what the adapter
 * does to it.
 */

function createFakeRuntimeEnvironment(): RuntimeEnvironment {
  return {
    clock: { now: () => 0 },
    scheduler: {
      schedule: () => ({ cancel: () => {} }),
      scheduleMicrotask: () => {},
    },
    logger: {
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

function createFakeAdapterHost(): AdapterHost<LegacyChatTranscriptSnapshotEvent> & {
  readonly emitted: LegacyChatTranscriptSnapshotEvent[];
  readonly resumeOutcomes: ResumeOutcome[];
  readonly statuses: AdapterStatus[];
  readonly requestReplacementCalls: ReplicaReplacementReason[];
} {
  const emitted: LegacyChatTranscriptSnapshotEvent[] = [];
  const resumeOutcomes: ResumeOutcome[] = [];
  const statuses: AdapterStatus[] = [];
  const requestReplacementCalls: ReplicaReplacementReason[] = [];
  return {
    environment: createFakeRuntimeEnvironment(),
    emitted,
    resumeOutcomes,
    statuses,
    requestReplacementCalls,
    emit: (event) => {
      emitted.push(event);
    },
    reportResume: (outcome) => {
      resumeOutcomes.push(outcome);
    },
    reportStatus: (status) => {
      statuses.push(status);
    },
    requestReplacement: (reason) => {
      requestReplacementCalls.push(reason);
    },
  };
}

/**
 * A minimal, schema-shaped legacy snapshot frame. The adapter never reads
 * into it - it only carries it through to `host.emit` - so the exact field
 * values are not the point; a distinguishing `chatId` per call is, so
 * `toBe`/`toEqual` assertions below are about identity, not coincidence.
 */
function legacyFrame(chatId: string): LegacyChatSnapshotFrame {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId,
    snapshot: {
      chat: {
        id: chatId,
        parentId: null,
        userId: "owner-1",
        hostId: "test-host",
        title: "Chat",
        createdAt: 1,
        updatedAt: 1,
        isTitleEditedByUser: false,
        settings: null,
        activeSessionChain: null,
        claudePendingWakes: [],
        messages: [],
        events: [],
        archivedAt: null,
        pinnedUserProviderHandle: null,
        lastDeliveredRolesDigest: null,
      },
      access: { role: "owner", ownerUserId: "owner-1", canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      managedCommands: [],
      heldUpdates: [],
    },
  };
}

describe("createLegacyChatTranscriptAdapter - descriptor", () => {
  it("reports the legacy kind, the pre-windowed lane id, and a human label", () => {
    const adapter = createLegacyChatTranscriptAdapter();

    expect(adapter.descriptor).toEqual({
      laneId: LEGACY_CHAT_TRANSCRIPT_LANE_ID,
      kind: "legacy",
      label: "chat.subscribe@1.0-1.7 (unbounded transcript)",
    });
  });
});

describe("createLegacyChatTranscriptAdapter - resumeOffer", () => {
  it("is always null, before and after attach, and after ingesting a snapshot", () => {
    const adapter = createLegacyChatTranscriptAdapter();

    // Before attach: no epoch, no cursor exists for this line at all.
    expect(adapter.resumeOffer()).toBeNull();

    const host = createFakeAdapterHost();
    adapter.attach(host);
    expect(adapter.resumeOffer()).toBeNull();

    // A snapshot never manufactures a cursor after the fact either - the
    // line simply has none, at any point in its lifecycle.
    adapter.ingestSnapshot(legacyFrame("chat-1"));
    expect(adapter.resumeOffer()).toBeNull();
  });
});

describe("createLegacyChatTranscriptAdapter - emission while attached", () => {
  it("emits exactly one legacy-unbounded-snapshot event per ingested frame, carrying the frame verbatim", () => {
    const adapter = createLegacyChatTranscriptAdapter();
    const host = createFakeAdapterHost();
    adapter.attach(host);

    const first = legacyFrame("chat-1");
    const second = legacyFrame("chat-2");
    adapter.ingestSnapshot(first);
    adapter.ingestSnapshot(second);

    expect(host.emitted).toHaveLength(2);
    expect(host.emitted[0]).toEqual({
      kind: "legacy-unbounded-snapshot",
      frame: first,
    });
    expect(host.emitted[1]).toEqual({
      kind: "legacy-unbounded-snapshot",
      frame: second,
    });
    // Carried through, not copied: the same object reference the caller
    // handed the adapter is what the host receives.
    expect(host.emitted[0]?.frame).toBe(first);
    expect(host.emitted[1]?.frame).toBe(second);
  });

  it("ingesting before attach is a silent no-op - there is no host to emit to", () => {
    const adapter = createLegacyChatTranscriptAdapter();

    adapter.ingestSnapshot(legacyFrame("chat-1"));

    const host = createFakeAdapterHost();
    adapter.attach(host);
    // The pre-attach frame was never buffered; only frames ingested AFTER
    // attach are ever seen.
    expect(host.emitted).toEqual([]);
  });
});

describe("createLegacyChatTranscriptAdapter - detach", () => {
  it("stops emitting once detached, even though ingestSnapshot keeps being called", () => {
    const adapter = createLegacyChatTranscriptAdapter();
    const host = createFakeAdapterHost();
    adapter.attach(host);

    adapter.ingestSnapshot(legacyFrame("chat-1"));
    expect(host.emitted).toHaveLength(1);

    adapter.detach("disposed");
    adapter.ingestSnapshot(legacyFrame("chat-2"));
    adapter.ingestSnapshot(legacyFrame("chat-3"));

    // No further emission reached the ORIGINAL host - proves detach() drops
    // the host reference rather than merely flagging future calls.
    expect(host.emitted).toHaveLength(1);
    expect(host.emitted[0]).toEqual({
      kind: "legacy-unbounded-snapshot",
      frame: legacyFrame("chat-1"),
    });
  });

  it("detach is terminal - a later attach() on the same instance never takes effect", () => {
    const adapter = createLegacyChatTranscriptAdapter();
    const firstHost = createFakeAdapterHost();
    adapter.attach(firstHost);
    adapter.detach("superseded");

    const secondHost = createFakeAdapterHost();
    adapter.attach(secondHost);
    adapter.ingestSnapshot(legacyFrame("chat-1"));

    // `LaneAdapter.attach`'s own contract: an adapter that has been detached
    // is not re-attached, the runtime builds a fresh one instead. This is
    // that per-instance latch, not the stream's generation guard.
    expect(secondHost.emitted).toEqual([]);
  });
});

describe("createLegacyChatTranscriptAdapter - never originates a replacement", () => {
  it("requestReplacement is never called across attach, several snapshots, and detach", () => {
    const adapter = createLegacyChatTranscriptAdapter();
    const host = createFakeAdapterHost();
    adapter.attach(host);

    adapter.ingestSnapshot(legacyFrame("chat-1"));
    adapter.ingestSnapshot(legacyFrame("chat-2"));
    adapter.detach("disposed");

    // The adapter speaks for the authority and is structurally unable to
    // originate a client reseed - proven by recording every call the fake
    // host actually received, not merely by absence of a positive assertion.
    expect(host.requestReplacementCalls).toEqual([]);
    expect(host.resumeOutcomes).toEqual([]);
    expect(host.statuses).toEqual([]);
  });
});
