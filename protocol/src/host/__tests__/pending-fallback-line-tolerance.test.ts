import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  chatSnapshotSchema,
  chatSubscribeV19,
  chatWindowedSnapshotSchema,
  pendingFallbackSchema,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * Tolerance proof for the additive-optional `pendingFallback` field
 * (`chat.subscribe@1.9`): the live windowed line CARRIES it, and every
 * released `chat.subscribe@1.0-1.8` line TOLERATES it - parses a frame
 * carrying it without failing, and does not surface the key on the parsed
 * result, because each of those lines is a hand-frozen literal pre-image
 * rather than a reference to the live schema.
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

function pendingFallbackFixture() {
  return {
    traversalId: "traversal-1",
    revision: 3,
    state: "choosing" as const,
    reason: "rate_limited",
    failedTuple: chatRunSettingsFixture("gpt-5"),
    targetTuple: chatRunSettingsFixture("claude-opus-5"),
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

describe("chat.subscribe@1.9 carries a fully-populated pendingFallback", () => {
  it("the fixture covers every pendingFallbackSchema field", () => {
    assertFixtureMatchesSchema();
  });

  it("round-trips pendingFallback intact on a snapshot frame", () => {
    const pendingFallback = pendingFallbackFixture();
    const parsed = chatSubscribeV19.serverFrameSchema.parse(
      frame("snapshot", {
        snapshot: { ...baseWindowedSnapshot(), pendingFallback },
      }),
    );

    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.snapshot.pendingFallback).toEqual(pendingFallback);
  });

  it("round-trips pendingFallback intact on a turnStateChanged frame", () => {
    const pendingFallback = pendingFallbackFixture();
    const parsed = chatSubscribeV19.serverFrameSchema.parse(
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

// ─── Half 2: every released `1.0`-`1.8` line TOLERATES it without gaining it ─

const chatSubscribeLine = hostStreamRpcRegistry["chat.subscribe"][1];

// `chatSubscribeV19` (minor 9) is the live line proven above; everything
// below it is released and must only tolerate, never carry.
const RELEASED_MINORS = Object.keys(chatSubscribeLine.versions)
  .map(Number)
  .filter((minor) => minor < 9)
  .sort((a, b) => a - b);

describe("every released chat.subscribe line tolerates pendingFallback without gaining it", () => {
  it("covers chat.subscribe@1.0 through @1.8 (nothing added later silently drops out)", () => {
    expect(RELEASED_MINORS).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  for (const minor of RELEASED_MINORS) {
    const version = `1.${minor}`;

    describe(`chat.subscribe@${version}`, () => {
      const { contract } = chatSubscribeLine.versions[minor];

      // `1.8` is the released windowed line - its snapshot has no embedded
      // transcript and carries the bounded-window fields instead of
      // `accumulatedFileChanges`. Every other released minor (`1.0`-`1.7`)
      // still embeds the whole chat record.
      const isWindowed = minor === 8;

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
