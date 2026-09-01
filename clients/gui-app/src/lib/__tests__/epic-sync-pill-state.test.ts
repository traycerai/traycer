import { describe, expect, it } from "vitest";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { EpicCloudSyncStatus } from "@traycer/protocol/host/epic/subscribe";
import {
  createCommandQueue,
  type CommandRecord,
  type CommandResolution,
  type CommandSendFailure,
  type RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import {
  deriveEpicSyncPillState,
  deriveEpicWriteCommandAlert,
  NO_OUTSTANDING_WRITE_COMMANDS,
  summarizeEpicWriteCommands,
  type EpicHostDirtyState,
  type EpicSyncPillInputs,
  type EpicSyncPillState,
  type EpicWriteCommandSummary,
} from "@/lib/epic-sync-pill-state";

type Intent = { readonly value: string };

function makeEnvironment(now: () => number): RuntimeEnvironment {
  return {
    clock: { now },
    scheduler: {
      schedule: () => ({ cancel: () => undefined }),
      scheduleMicrotask: (callback) => callback(),
    },
    logger: {
      debug: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
}

function makeQueue(
  send: (command: CommandRecord<Intent>) => Promise<CommandResolution>,
  classifyFailure: (error: unknown) => CommandSendFailure,
) {
  let nextId = 0;
  return createCommandQueue<Intent>({
    environment: makeEnvironment(() => 123),
    idFactory: { next: () => `command-${++nextId}` },
    send,
    classifyFailure,
    accept: () => true,
    onEnqueued: () => true,
    onUnknownOutcome: () => undefined,
    onResolved: () => undefined,
  });
}

async function settleQueueMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function committed(hostId: string): CommandResolution {
  return { kind: "committed", hostId, entityVersion: 4 };
}

const HEALTHY_INPUTS: EpicSyncPillInputs = {
  hostTransportStatus: "open",
  cloudSyncStatus: "connected",
  hasFreshCloudSyncStatus: true,
  hostDirtyState: "clean",
  hasUnsyncedDocClassChanges: false,
  writeCommands: NO_OUTSTANDING_WRITE_COMMANDS,
  hasConnectedOnce: true,
};

const REJECTED_SUMMARY: EpicWriteCommandSummary = {
  pendingCount: 0,
  unknownOutcomeCount: 0,
  rejectedCount: 1,
  supersededCount: 0,
};

const SUPERSEDED_SUMMARY: EpicWriteCommandSummary = {
  pendingCount: 0,
  unknownOutcomeCount: 0,
  rejectedCount: 0,
  supersededCount: 1,
};

const UNKNOWN_OUTCOME_SUMMARY: EpicWriteCommandSummary = {
  pendingCount: 0,
  unknownOutcomeCount: 1,
  rejectedCount: 0,
  supersededCount: 0,
};

const PENDING_SUMMARY: EpicWriteCommandSummary = {
  pendingCount: 1,
  unknownOutcomeCount: 0,
  rejectedCount: 0,
  supersededCount: 0,
};

const HOST_TRANSPORT_STATUSES: readonly StreamConnectionStatus[] = [
  "connecting",
  "open",
  "reconnecting",
  "closed",
];
const CLOUD_SYNC_STATUSES: readonly EpicCloudSyncStatus[] = [
  "connected",
  "reconnecting",
  "disconnected",
];
const HOST_DIRTY_STATES: readonly EpicHostDirtyState[] = [
  "unknown",
  "clean",
  "dirty",
];
const BOOLEANS: readonly boolean[] = [false, true];
const WRITE_COMMAND_SUMMARIES: readonly EpicWriteCommandSummary[] = [
  NO_OUTSTANDING_WRITE_COMMANDS,
  PENDING_SUMMARY,
  UNKNOWN_OUTCOME_SUMMARY,
  REJECTED_SUMMARY,
  SUPERSEDED_SUMMARY,
];

function allCombinations(): readonly EpicSyncPillInputs[] {
  return HOST_TRANSPORT_STATUSES.flatMap((hostTransportStatus) =>
    CLOUD_SYNC_STATUSES.flatMap((cloudSyncStatus) =>
      BOOLEANS.flatMap((hasFreshCloudSyncStatus) =>
        HOST_DIRTY_STATES.flatMap((hostDirtyState) =>
          BOOLEANS.flatMap((hasUnsyncedDocClassChanges) =>
            WRITE_COMMAND_SUMMARIES.flatMap((writeCommands) =>
              BOOLEANS.map((hasConnectedOnce): EpicSyncPillInputs => ({
                hostTransportStatus,
                cloudSyncStatus,
                hasFreshCloudSyncStatus,
                hostDirtyState,
                hasUnsyncedDocClassChanges,
                writeCommands,
                hasConnectedOnce,
              })),
            ),
          ),
        ),
      ),
    ),
  );
}

const DURABILITY_CLAIMS: ReadonlySet<EpicSyncPillState> = new Set([
  "synced",
  "offlineChangesSavedLocally",
]);

describe("summarizeEpicWriteCommands", () => {
  it("counts a real pending record", async () => {
    const queue = makeQueue(
      () => new Promise<CommandResolution>(() => undefined),
      () => ({
        kind: "queued",
        reason: "offline",
        boundedRetry: false,
        retryAfterMs: null,
      }),
    );
    const record = queue.enqueue({
      intent: { value: "rename" },
      expectedEntityVersion: null,
    });
    if (record === null) throw new Error("expected command");
    await settleQueueMicrotasks();

    expect(summarizeEpicWriteCommands(queue.list())).toEqual({
      pendingCount: 1,
      unknownOutcomeCount: 0,
      rejectedCount: 0,
      supersededCount: 0,
    });
  });

  it("counts a real unknown-outcome record", async () => {
    const queue = makeQueue(
      () => Promise.reject(new Error("connection dropped after send")),
      () => ({
        kind: "unknown-outcome",
        reason: "connection dropped after send",
      }),
    );
    const record = queue.enqueue({
      intent: { value: "rename" },
      expectedEntityVersion: null,
    });
    if (record === null) throw new Error("expected command");
    await settleQueueMicrotasks();

    expect(summarizeEpicWriteCommands(queue.list())).toEqual({
      pendingCount: 0,
      unknownOutcomeCount: 1,
      rejectedCount: 0,
      supersededCount: 0,
    });
  });

  it("counts a real rejected record", async () => {
    const resolution: CommandResolution = {
      kind: "rejected",
      code: "PRECONDITION_FAILED",
      reason: "The artifact changed on the host",
      retryable: true,
    };
    const queue = makeQueue(
      () => Promise.resolve(resolution),
      () => ({ kind: "rejected", resolution }),
    );
    const record = queue.enqueue({
      intent: { value: "rename" },
      expectedEntityVersion: 3,
    });
    if (record === null) throw new Error("expected command");
    await settleQueueMicrotasks();

    expect(summarizeEpicWriteCommands(queue.list())).toEqual({
      pendingCount: 0,
      unknownOutcomeCount: 0,
      rejectedCount: 1,
      supersededCount: 0,
    });
  });

  it("counts a real superseded record", async () => {
    const queue = makeQueue(
      () => Promise.resolve(committed("host-1")),
      () => ({
        kind: "queued",
        reason: "offline",
        boundedRetry: false,
        retryAfterMs: null,
      }),
    );
    const record = queue.enqueue({
      intent: { value: "rename" },
      expectedEntityVersion: null,
    });
    if (record === null) throw new Error("expected command");
    await settleQueueMicrotasks();
    expect(queue.list()[0]?.state).toBe("committed");

    queue.resolve(record.commandId, {
      kind: "superseded",
      observedAtMs: 456,
      via: "record-lane",
    });

    expect(summarizeEpicWriteCommands(queue.list())).toEqual({
      pendingCount: 0,
      unknownOutcomeCount: 0,
      rejectedCount: 0,
      supersededCount: 1,
    });
  });

  // A real bug fix on this branch: the old pill folded `writeCommands.length
  // > 0` into divergence, so a committed-but-unacknowledged record pinned it
  // to "Saving changes" for the rest of the session.
  it("counts a committed record as NOTHING, and the pill still reads synced with it present", async () => {
    const queue = makeQueue(
      () => Promise.resolve(committed("host-1")),
      () => ({
        kind: "queued",
        reason: "offline",
        boundedRetry: false,
        retryAfterMs: null,
      }),
    );
    const record = queue.enqueue({
      intent: { value: "rename" },
      expectedEntityVersion: null,
    });
    if (record === null) throw new Error("expected command");
    await settleQueueMicrotasks();
    expect(queue.list()[0]?.state).toBe("committed");

    const summary = summarizeEpicWriteCommands(queue.list());
    expect(summary).toEqual(NO_OUTSTANDING_WRITE_COMMANDS);
    expect(
      deriveEpicSyncPillState({ ...HEALTHY_INPUTS, writeCommands: summary }),
    ).toBe("synced");
  });
});

describe("deriveEpicWriteCommandAlert", () => {
  it("returns null on an empty summary", () => {
    expect(deriveEpicWriteCommandAlert(NO_OUTSTANDING_WRITE_COMMANDS)).toBe(
      null,
    );
  });

  it("prefers rejected over superseded and outcomeUnknown", () => {
    expect(
      deriveEpicWriteCommandAlert({
        pendingCount: 0,
        unknownOutcomeCount: 1,
        rejectedCount: 1,
        supersededCount: 1,
      }),
    ).toBe("rejected");
  });

  it("prefers superseded over outcomeUnknown when nothing is rejected", () => {
    expect(
      deriveEpicWriteCommandAlert({
        pendingCount: 0,
        unknownOutcomeCount: 1,
        rejectedCount: 0,
        supersededCount: 1,
      }),
    ).toBe("superseded");
  });

  it("falls back to outcomeUnknown when nothing terminal is outstanding", () => {
    expect(deriveEpicWriteCommandAlert(UNKNOWN_OUTCOME_SUMMARY)).toBe(
      "outcomeUnknown",
    );
  });
});

describe("deriveEpicSyncPillState", () => {
  it("negative control: every leg clean and connected reads synced", () => {
    expect(deriveEpicSyncPillState(HEALTHY_INPUTS)).toBe("synced");
  });

  it("distinguishes host-durable cloud-pending work from renderer-only work", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      hostDirtyState: "dirty",
    });
    expect(result).toBe("hostPending");
  });

  it("unsynced doc-class changes alone force syncing", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      hasUnsyncedDocClassChanges: true,
    });
    expect(result).toBe("syncing");
  });

  it("a pending write command alone forces syncing, same as a doc-class change", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      writeCommands: PENDING_SUMMARY,
    });
    expect(result).toBe("syncing");
  });

  it("an unknown-outcome write command alone forces syncing", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      writeCommands: UNKNOWN_OUTCOME_SUMMARY,
    });
    expect(result).toBe("syncing");
  });

  it("cloud disconnected with aggregate host-pending work makes no durability claim", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      cloudSyncStatus: "disconnected",
      hostDirtyState: "dirty",
    });
    expect(result).toBe("offlineWithHostPending");
  });

  it("cloud reconnecting with known host-durable work also stays offlineWithHostPending", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      cloudSyncStatus: "reconnecting",
      hostDirtyState: "dirty",
    });
    expect(result).toBe("offlineWithHostPending");
  });

  it("warns immediately without calling renderer-only work saved locally while the cloud is down", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      cloudSyncStatus: "disconnected",
      hostDirtyState: "dirty",
      hasUnsyncedDocClassChanges: true,
    });
    expect(result).toBe("offlineWithUnsavedChanges");
  });

  it("uses neutral connected while the host-dirty snapshot is unknown", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      hostDirtyState: "unknown",
    });
    expect(result).toBe("connected");
  });

  it("uses neutral connected until this open cycle receives a cloud-status frame", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      hasFreshCloudSyncStatus: false,
    });
    expect(result).toBe("connected");
  });

  it("cloud disconnected with nothing outstanding falls back to reconnecting", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      cloudSyncStatus: "disconnected",
    });
    expect(result).toBe("reconnecting");
  });

  it("cloud disconnected with nothing outstanding falls back to connecting when never connected before", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      cloudSyncStatus: "disconnected",
      hasConnectedOnce: false,
    });
    expect(result).toBe("connecting");
  });

  it("host transport closed reads offline regardless of hasConnectedOnce", () => {
    expect(
      deriveEpicSyncPillState({
        ...HEALTHY_INPUTS,
        hostTransportStatus: "closed",
      }),
    ).toBe("offline");
    expect(
      deriveEpicSyncPillState({
        ...HEALTHY_INPUTS,
        hostTransportStatus: "closed",
        hasConnectedOnce: false,
      }),
    ).toBe("offline");
  });

  it("host transport connecting reads connecting when never connected before", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      hostTransportStatus: "connecting",
      hasConnectedOnce: false,
    });
    expect(result).toBe("connecting");
  });

  it("host transport connecting reads reconnecting once already connected before", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      hostTransportStatus: "connecting",
      hasConnectedOnce: true,
    });
    expect(result).toBe("reconnecting");
  });

  describe("a rejected or superseded write is never absorbed into a green claim", () => {
    it("a rejected write drops synced to connected while everything else is healthy", () => {
      const result = deriveEpicSyncPillState({
        ...HEALTHY_INPUTS,
        writeCommands: REJECTED_SUMMARY,
      });
      expect(result).not.toBe("synced");
      expect(deriveEpicWriteCommandAlert(REJECTED_SUMMARY)).toBe("rejected");
    });

    it("a superseded write drops synced to connected while everything else is healthy", () => {
      const result = deriveEpicSyncPillState({
        ...HEALTHY_INPUTS,
        writeCommands: SUPERSEDED_SUMMARY,
      });
      expect(result).not.toBe("synced");
      expect(deriveEpicWriteCommandAlert(SUPERSEDED_SUMMARY)).toBe(
        "superseded",
      );
    });
  });

  describe("no unestablished input ever renders as synced", () => {
    it("transport not open", () => {
      expect(
        deriveEpicSyncPillState({
          ...HEALTHY_INPUTS,
          hostTransportStatus: "reconnecting",
        }),
      ).not.toBe("synced");
    });

    it("cloud-sync status not fresh", () => {
      expect(
        deriveEpicSyncPillState({
          ...HEALTHY_INPUTS,
          hasFreshCloudSyncStatus: false,
        }),
      ).not.toBe("synced");
    });

    it("host dirty state unknown", () => {
      expect(
        deriveEpicSyncPillState({
          ...HEALTHY_INPUTS,
          hostDirtyState: "unknown",
        }),
      ).not.toBe("synced");
    });

    it("doc-class changes unsynced", () => {
      expect(
        deriveEpicSyncPillState({
          ...HEALTHY_INPUTS,
          hasUnsyncedDocClassChanges: true,
        }),
      ).not.toBe("synced");
    });

    it("a pending write command", () => {
      expect(
        deriveEpicSyncPillState({
          ...HEALTHY_INPUTS,
          writeCommands: PENDING_SUMMARY,
        }),
      ).not.toBe("synced");
    });

    it("an unknown-outcome write command", () => {
      expect(
        deriveEpicSyncPillState({
          ...HEALTHY_INPUTS,
          writeCommands: UNKNOWN_OUTCOME_SUMMARY,
        }),
      ).not.toBe("synced");
    });

    it("a rejected write command", () => {
      expect(
        deriveEpicSyncPillState({
          ...HEALTHY_INPUTS,
          writeCommands: REJECTED_SUMMARY,
        }),
      ).not.toBe("synced");
    });

    it("a superseded write command", () => {
      expect(
        deriveEpicSyncPillState({
          ...HEALTHY_INPUTS,
          writeCommands: SUPERSEDED_SUMMARY,
        }),
      ).not.toBe("synced");
    });
  });

  // `offlineChangesSavedLocally` is a deliberately unreachable member of the
  // union: the aggregate dirty bit does not prove the newest bytes reached
  // the host's own durable store, so the ladder always resolves that case to
  // `offlineWithHostPending` instead. Pinned here so a future change that
  // starts returning it has to be a deliberate decision, not a regression
  // this suite let slide.
  it("offlineChangesSavedLocally is never returned by any combination", () => {
    const combos = allCombinations();
    for (const inputs of combos) {
      expect(deriveEpicSyncPillState(inputs)).not.toBe(
        "offlineChangesSavedLocally",
      );
    }
  });

  describe("exhaustive invariants over all combinations, including the write-command dimension", () => {
    const combos = allCombinations();

    it("the enumerated matrix has exactly 1440 combinations", () => {
      expect(combos.length).toBe(1440);
    });

    it("synced is returned iff transport and cloud status are fresh/connected, host dirtiness is clean, no doc-class divergence, and the write-command summary is entirely empty", () => {
      for (const inputs of combos) {
        const result = deriveEpicSyncPillState(inputs);
        const expectedSynced =
          inputs.hostTransportStatus === "open" &&
          inputs.cloudSyncStatus === "connected" &&
          inputs.hasFreshCloudSyncStatus &&
          inputs.hostDirtyState === "clean" &&
          !inputs.hasUnsyncedDocClassChanges &&
          inputs.writeCommands.pendingCount === 0 &&
          inputs.writeCommands.unknownOutcomeCount === 0 &&
          inputs.writeCommands.rejectedCount === 0 &&
          inputs.writeCommands.supersededCount === 0;
        if (expectedSynced) {
          expect(result).toBe("synced");
        } else {
          expect(result).not.toBe("synced");
        }
      }
    });

    it("never claims durability while the host transport is not open", () => {
      for (const inputs of combos) {
        if (inputs.hostTransportStatus === "open") continue;
        const result = deriveEpicSyncPillState(inputs);
        expect(DURABILITY_CLAIMS.has(result)).toBe(false);
      }
    });
  });

  describe("old-host compatibility (host dirtiness stays unknown)", () => {
    it("never claims synced for a clean-looking @1.0 session", () => {
      const result = deriveEpicSyncPillState({
        ...HEALTHY_INPUTS,
        hostDirtyState: "unknown",
      });
      expect(result).toBe("connected");
    });

    it("warns about renderer-only work when the known cloud link is down", () => {
      const result = deriveEpicSyncPillState({
        ...HEALTHY_INPUTS,
        cloudSyncStatus: "disconnected",
        hostDirtyState: "unknown",
        hasUnsyncedDocClassChanges: true,
      });
      expect(result).toBe("offlineWithUnsavedChanges");
    });
  });
});
