import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  chatSnapshotSchema,
  chatSubscribeV110,
  chatWindowedSnapshotSchema,
  lastFailedAttemptSchema,
  pendingFallbackSchema,
  pendingReturnSchema,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * Tolerance proof for the additive-optional `pendingFallback` and
 * `pendingReturn` fields (`chat.subscribe@1.10`): the live windowed line
 * CARRIES them, and every frozen `chat.subscribe@1.0-1.9` line TOLERATES
 * them - parses a frame carrying either without failing, and does not
 * surface the key on the parsed result, because each of those lines is a
 * hand-frozen literal pre-image rather than a reference to the live schema.
 *
 * Not a host-ablation target. Gutting the host projectors cannot redden
 * these tests (no causal connection): they pin frozen pre-images. What they
 * would catch is a frozen line growing an optional `pendingReturn` /
 * `pendingFallback` that `.optional()` preserves on parse.
 */

// ─── Shared fixtures ────────────────────────────────────────────────────────

function chatRunSettingsFixture(model: string) {
  return {
    harnessId: "claude" as const,
    model,
    permissionMode: "full_access" as const,
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular" as const,
    profileId: null,
  };
}

function fallbackImpendingActionFixture() {
  return {
    planId: "plan-1",
    rung: "profile" as const,
    target: chatRunSettingsFixture("claude-opus-5"),
    targetModelFamily: null,
    resumesAt: null,
    pending: null,
  };
}

function pendingFallbackFixture() {
  return {
    traversalId: "traversal-1",
    revision: 3,
    state: "choosing" as const,
    reason: "rate_limited",
    failedTuple: chatRunSettingsFixture("gpt-5"),
    targetTuple: chatRunSettingsFixture("claude-opus-5"),
    // F5 (D202's sibling item): the impending-action preview, additive on
    // `pendingFallbackSchema` since `chat.subscribe@1.10`. Populated, not
    // `null` - a `null` here would make every "strips the KEY" assertion in
    // Half 2 below pass whether or not the nested field was ever projected
    // away, since the container itself is what those assertions delete.
    impendingAction: fallbackImpendingActionFixture(),
    deadline: 1_700_000_000_000,
    graceRemainingMs: 5_000,
    attempt: 2,
    maxAttempts: 5,
    queuedItemsMoving: 4,
    siblingSwitching: 1,
  };
}

// Every field on `pendingFallbackFixture()` is asserted present, so a field
// this fixture forgot to populate would silently mark itself "carried"
// without ever having been sent.
function assertFixtureMatchesSchema() {
  expect(Object.keys(pendingFallbackFixture()).sort()).toEqual(
    Object.keys(pendingFallbackSchema.shape).sort(),
  );
}

// The minimal chat record every `chat.subscribe` line's frozen (or live)
// chat schema accepts: every version from `1.0` through the live line
// requires exactly this base set, with everything else defaulted.
function baseChat() {
  return {
    parentId: null,
    id: "chat-1",
    userId: "user-1",
    hostId: "host-1",
    title: "Chat",
    createdAt: 1000,
    updatedAt: 1000,
    isTitleEditedByUser: false,
    messages: [],
  };
}

function baseAux() {
  return {
    access: { role: "owner" as const, ownerUserId: "user-1", canAct: true },
    queue: { status: "idle" as const, items: [] },
    runStatus: "idle" as const,
    activeTurn: null,
    pendingApprovals: [],
    pendingInterviews: [],
    worktreeBinding: null,
    missingWorktreePaths: [],
    pendingFileEditApprovals: [],
  };
}

function baseWindowedSnapshot(): Record<string, unknown> {
  return {
    chat: {
      parentId: null,
      id: "chat-1",
      userId: "user-1",
      hostId: "host-1",
      title: "Chat",
      createdAt: 1000,
      updatedAt: 1000,
      isTitleEditedByUser: false,
    },
    ...baseAux(),
    accumulatedFileChangeCount: 0,
    transcriptEpoch: 0,
    rowCount: 0,
    indexRevision: null,
    tail: { fromOrdinal: 0, messages: [], events: [] },
    derived: {
      latestAssistantUsage: null,
      pinnedTodo: null,
      pinnedTaskTodoItems: [],
      latestForkableAssistantMessageId: null,
      restorableSetupInterruption: null,
      interviewAnswerability: [],
      latestAssistantAuthFailureTurnKey: null,
      setupCardWindows: [],
    },
  };
}

function frame(
  kind: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind,
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    ...body,
  };
}

// ─── Half 1: the live windowed line CARRIES pendingFallback ───────────────

describe("chat.subscribe@1.10 carries a fully-populated pendingFallback", () => {
  it("the fixture covers every pendingFallbackSchema field", () => {
    assertFixtureMatchesSchema();
  });

  it("round-trips pendingFallback intact on a snapshot frame", () => {
    const pendingFallback = pendingFallbackFixture();
    const parsed = chatSubscribeV110.serverFrameSchema.parse(
      frame("snapshot", {
        snapshot: { ...baseWindowedSnapshot(), pendingFallback },
      }),
    );

    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.snapshot.pendingFallback).toEqual(pendingFallback);
  });

  it("round-trips pendingFallback intact on a turnStateChanged frame", () => {
    const pendingFallback = pendingFallbackFixture();
    const parsed = chatSubscribeV110.serverFrameSchema.parse(
      frame("turnStateChanged", {
        runStatus: "running",
        activeTurn: null,
        pendingFallback,
      }),
    );

    if (parsed.kind !== "turnStateChanged") {
      throw new Error("expected turnStateChanged");
    }
    expect(parsed.pendingFallback).toEqual(pendingFallback);
  });

  // Direct schema-level corroboration for the two DTOs the coordinator named
  // explicitly, independent of which wire frame embeds them.
  it("chatWindowedSnapshotSchema retains pendingFallback intact", () => {
    const pendingFallback = pendingFallbackFixture();
    const parsed = chatWindowedSnapshotSchema.parse({
      ...baseWindowedSnapshot(),
      pendingFallback,
    });
    expect(parsed.pendingFallback).toEqual(pendingFallback);
  });

  it("chatSnapshotSchema (the full, non-windowed live snapshot) retains pendingFallback intact", () => {
    const pendingFallback = pendingFallbackFixture();
    const parsed = chatSnapshotSchema.parse({
      chat: baseChat(),
      ...baseAux(),
      accumulatedFileChanges: [],
      pendingFallback,
    });
    expect(parsed.pendingFallback).toEqual(pendingFallback);
  });
});

// ─── Half 2: every frozen `1.0`-`1.9` line TOLERATES it without gaining it ──

const chatSubscribeLine = hostStreamRpcRegistry["chat.subscribe"][1];

// `chatSubscribeV110` (minor 10) is the live line proven above; everything
// below it is frozen and must only tolerate, never carry.
const RELEASED_MINORS = Object.keys(chatSubscribeLine.versions)
  .map(Number)
  .filter((minor) => minor < 10)
  .sort((a, b) => a - b);

describe("every frozen chat.subscribe line tolerates pendingFallback without gaining it", () => {
  it("covers chat.subscribe@1.0 through @1.9 (nothing added later silently drops out)", () => {
    expect(RELEASED_MINORS).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  for (const minor of RELEASED_MINORS) {
    const version = `1.${minor}`;

    describe(`chat.subscribe@${version}`, () => {
      const { contract } = chatSubscribeLine.versions[minor];

      // `1.8` and `1.9` are the frozen windowed lines - their snapshot has no
      // embedded transcript and carries the bounded-window fields instead of
      // `accumulatedFileChanges`. Every other frozen minor (`1.0`-`1.7`)
      // still embeds the whole chat record.
      const isWindowed = minor >= 8;

      it("parses a snapshot frame carrying pendingFallback, and strips the key", () => {
        const pendingFallback = pendingFallbackFixture();
        const snapshot = isWindowed
          ? { ...baseWindowedSnapshot(), pendingFallback }
          : {
              chat: baseChat(),
              ...baseAux(),
              accumulatedFileChanges: [],
              pendingFallback,
            };
        const result = contract.serverFrameSchema.safeParse(
          frame("snapshot", { snapshot }),
        );

        expect(result.success).toBe(true);
        if (!result.success) return;
        const parsed = result.data as { kind: string; snapshot?: unknown };
        if (parsed.kind !== "snapshot") throw new Error("expected snapshot");

        expect(
          Object.hasOwn(parsed.snapshot as object, "pendingFallback"),
        ).toBe(false);
      });

      it("parses a turnStateChanged frame carrying pendingFallback, and strips the key", () => {
        const pendingFallback = pendingFallbackFixture();
        const result = contract.serverFrameSchema.safeParse(
          frame("turnStateChanged", {
            runStatus: "running",
            activeTurn: null,
            pendingFallback,
          }),
        );

        expect(result.success).toBe(true);
        if (!result.success) return;
        const parsed = result.data as { kind: string };
        if (parsed.kind !== "turnStateChanged") {
          throw new Error("expected turnStateChanged");
        }

        expect(Object.hasOwn(parsed as object, "pendingFallback")).toBe(false);
      });
    });
  }
});

function pendingReturnFixture() {
  return {
    traversalId: "traversal-return-1",
    revision: 4,
    preferredTuple: chatRunSettingsFixture("gpt-5"),
    fallbackTuple: chatRunSettingsFixture("claude-opus-5"),
    queuedItemsMoving: 2,
    offeredAt: 1_700_000_000_000,
  };
}

function assertReturnFixtureMatchesSchema() {
  expect(Object.keys(pendingReturnFixture()).sort()).toEqual(
    Object.keys(pendingReturnSchema.shape).sort(),
  );
}

describe("chat.subscribe@1.10 carries a fully-populated pendingReturn", () => {
  it("the fixture covers every pendingReturnSchema field", () => {
    assertReturnFixtureMatchesSchema();
  });

  it("round-trips pendingReturn intact on a snapshot frame", () => {
    const pendingReturn = pendingReturnFixture();
    const parsed = chatSubscribeV110.serverFrameSchema.parse(
      frame("snapshot", {
        snapshot: { ...baseWindowedSnapshot(), pendingReturn },
      }),
    );
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.snapshot.pendingReturn).toEqual(pendingReturn);
  });

  it("round-trips pendingReturn intact on a turnStateChanged frame", () => {
    const pendingReturn = pendingReturnFixture();
    const parsed = chatSubscribeV110.serverFrameSchema.parse(
      frame("turnStateChanged", {
        runStatus: "running",
        activeTurn: null,
        pendingReturn,
      }),
    );
    if (parsed.kind !== "turnStateChanged") {
      throw new Error("expected turnStateChanged");
    }
    expect(parsed.pendingReturn).toEqual(pendingReturn);
  });

  it("chatWindowedSnapshotSchema retains pendingReturn intact", () => {
    const pendingReturn = pendingReturnFixture();
    const parsed = chatWindowedSnapshotSchema.parse({
      ...baseWindowedSnapshot(),
      pendingReturn,
    });
    expect(parsed.pendingReturn).toEqual(pendingReturn);
  });

  it("chatSnapshotSchema retains pendingReturn intact", () => {
    const pendingReturn = pendingReturnFixture();
    const parsed = chatSnapshotSchema.parse({
      chat: baseChat(),
      ...baseAux(),
      accumulatedFileChanges: [],
      pendingReturn,
    });
    expect(parsed.pendingReturn).toEqual(pendingReturn);
  });
});

describe("every frozen chat.subscribe line tolerates pendingReturn without gaining it", () => {
  it("covers chat.subscribe@1.0 through @1.9 (nothing added later silently drops out)", () => {
    expect(RELEASED_MINORS).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  for (const minor of RELEASED_MINORS) {
    const version = `1.${minor}`;

    describe(`chat.subscribe@${version}`, () => {
      const { contract } = chatSubscribeLine.versions[minor];
      const isWindowed = minor >= 8;

      it("parses a snapshot frame carrying pendingReturn, and strips the key", () => {
        const pendingReturn = pendingReturnFixture();
        const snapshot = isWindowed
          ? { ...baseWindowedSnapshot(), pendingReturn }
          : {
              chat: baseChat(),
              ...baseAux(),
              accumulatedFileChanges: [],
              pendingReturn,
            };
        const result = contract.serverFrameSchema.safeParse(
          frame("snapshot", { snapshot }),
        );
        expect(result.success).toBe(true);
        if (!result.success) return;
        const parsed = result.data as { kind: string; snapshot?: unknown };
        if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
        expect(Object.hasOwn(parsed.snapshot as object, "pendingReturn")).toBe(
          false,
        );
      });

      it("parses a turnStateChanged frame carrying pendingReturn, and strips the key", () => {
        const pendingReturn = pendingReturnFixture();
        const result = contract.serverFrameSchema.safeParse(
          frame("turnStateChanged", {
            runStatus: "running",
            activeTurn: null,
            pendingReturn,
          }),
        );
        expect(result.success).toBe(true);
        if (!result.success) return;
        const parsed = result.data as { kind: string };
        if (parsed.kind !== "turnStateChanged") {
          throw new Error("expected turnStateChanged");
        }
        expect(Object.hasOwn(parsed as object, "pendingReturn")).toBe(false);
      });

      it("parses a card-clearing snapshot (pendingReturn own key undefined) and strips the key", () => {
        const snapshot = isWindowed
          ? { ...baseWindowedSnapshot(), pendingReturn: undefined }
          : {
              chat: baseChat(),
              ...baseAux(),
              accumulatedFileChanges: [],
              pendingReturn: undefined,
            };
        const result = contract.serverFrameSchema.safeParse(
          frame("snapshot", { snapshot }),
        );
        expect(result.success).toBe(true);
        if (!result.success) return;
        const parsed = result.data as { kind: string; snapshot?: unknown };
        if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
        expect(Object.hasOwn(parsed.snapshot as object, "pendingReturn")).toBe(
          false,
        );
      });
    });
  }
});

/**
 * Fully populated on purpose, `agentFailure`'s four optionals included: the
 * fixture-vs-schema guard below only proves the TOP level covers the schema, so
 * a nested optional left unset would ride every round-trip below without ever
 * being carried. `resetsAt`/`resetsAtSource` in particular are the pair the
 * wait affordance's copy reads.
 */
function lastFailedAttemptFixture() {
  return {
    userMessageId: "user-message-d152-1",
    turnId: "turn-d152-1",
    failure: {
      reason: "rate_limit",
      resetsAt: 1_700_000_600_000,
      resetsAtSource: "provider",
      scope: "five_hour",
      providerDetail: "code=rate_limit_exceeded",
    },
    // All three, so the round-trip carries a populated array. The EMPTY case is
    // a distinct fact (host admitted nothing) and is pinned separately.
    eligibleRungs: ["retry", "switch", "wait_once"],
    // F6: `eligible` is the one value that AGREES with `eligibleRungs`
    // above carrying `wait_once` - the two are one host decision, so a
    // fixture pairing `wait_once` with any other disposition would be
    // asserting a state the producer cannot emit.
    waitDisposition: "eligible" as const,
  };
}

function assertLastFailedFixtureMatchesSchema() {
  expect(Object.keys(lastFailedAttemptFixture()).sort()).toEqual(
    Object.keys(lastFailedAttemptSchema.shape).sort(),
  );
}

describe("chat.subscribe@1.10 carries a fully-populated lastFailedAttempt", () => {
  it("the fixture covers every lastFailedAttemptSchema field", () => {
    assertLastFailedFixtureMatchesSchema();
  });

  it("round-trips lastFailedAttempt intact on a snapshot frame", () => {
    const lastFailedAttempt = lastFailedAttemptFixture();
    const parsed = chatSubscribeV110.serverFrameSchema.parse(
      frame("snapshot", {
        snapshot: { ...baseWindowedSnapshot(), lastFailedAttempt },
      }),
    );
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.snapshot.lastFailedAttempt).toEqual(lastFailedAttempt);
  });

  it("round-trips lastFailedAttempt intact on a turnStateChanged frame", () => {
    const lastFailedAttempt = lastFailedAttemptFixture();
    const parsed = chatSubscribeV110.serverFrameSchema.parse(
      frame("turnStateChanged", {
        runStatus: "running",
        activeTurn: null,
        lastFailedAttempt,
      }),
    );
    if (parsed.kind !== "turnStateChanged") {
      throw new Error("expected turnStateChanged");
    }
    expect(parsed.lastFailedAttempt).toEqual(lastFailedAttempt);
  });

  it("chatWindowedSnapshotSchema retains lastFailedAttempt intact", () => {
    const lastFailedAttempt = lastFailedAttemptFixture();
    const parsed = chatWindowedSnapshotSchema.parse({
      ...baseWindowedSnapshot(),
      lastFailedAttempt,
    });
    expect(parsed.lastFailedAttempt).toEqual(lastFailedAttempt);
  });

  it("chatSnapshotSchema retains lastFailedAttempt intact", () => {
    const lastFailedAttempt = lastFailedAttemptFixture();
    const parsed = chatSnapshotSchema.parse({
      chat: baseChat(),
      ...baseAux(),
      accumulatedFileChanges: [],
      lastFailedAttempt,
    });
    expect(parsed.lastFailedAttempt).toEqual(lastFailedAttempt);
  });
});

describe("every frozen chat.subscribe line tolerates lastFailedAttempt without gaining it", () => {
  for (const minor of RELEASED_MINORS) {
    const version = `1.${minor}`;

    describe(`chat.subscribe@${version}`, () => {
      const { contract } = chatSubscribeLine.versions[minor];
      const isWindowed = minor >= 8;

      it("parses a snapshot frame carrying lastFailedAttempt, and strips the key", () => {
        const lastFailedAttempt = lastFailedAttemptFixture();
        const snapshot = isWindowed
          ? { ...baseWindowedSnapshot(), lastFailedAttempt }
          : {
              chat: baseChat(),
              ...baseAux(),
              accumulatedFileChanges: [],
              lastFailedAttempt,
            };
        const result = contract.serverFrameSchema.safeParse(
          frame("snapshot", { snapshot }),
        );
        expect(result.success).toBe(true);
        if (!result.success) return;
        const parsed = result.data as { kind: string; snapshot?: unknown };
        if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
        expect(
          Object.hasOwn(parsed.snapshot as object, "lastFailedAttempt"),
        ).toBe(false);
      });

      it("parses a turnStateChanged frame carrying lastFailedAttempt, and strips the key", () => {
        const lastFailedAttempt = lastFailedAttemptFixture();
        const result = contract.serverFrameSchema.safeParse(
          frame("turnStateChanged", {
            runStatus: "running",
            activeTurn: null,
            lastFailedAttempt,
          }),
        );
        expect(result.success).toBe(true);
        if (!result.success) return;
        const parsed = result.data as { kind: string };
        if (parsed.kind !== "turnStateChanged") {
          throw new Error("expected turnStateChanged");
        }
        expect(Object.hasOwn(parsed as object, "lastFailedAttempt")).toBe(
          false,
        );
      });

      // The card-CLEARING frame, and the one the sibling funnel once got wrong
      // by testing value presence instead of key presence: an own key whose
      // value is `undefined` must still be stripped, because that is exactly
      // the frame that tells a client to take the card down.
      it("parses a card-clearing snapshot (lastFailedAttempt own key undefined) and strips the key", () => {
        const snapshot = isWindowed
          ? { ...baseWindowedSnapshot(), lastFailedAttempt: undefined }
          : {
              chat: baseChat(),
              ...baseAux(),
              accumulatedFileChanges: [],
              lastFailedAttempt: undefined,
            };
        const result = contract.serverFrameSchema.safeParse(
          frame("snapshot", { snapshot }),
        );
        expect(result.success).toBe(true);
        if (!result.success) return;
        const parsed = result.data as { kind: string; snapshot?: unknown };
        if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
        expect(
          Object.hasOwn(parsed.snapshot as object, "lastFailedAttempt"),
        ).toBe(false);
      });
    });
  }
});
