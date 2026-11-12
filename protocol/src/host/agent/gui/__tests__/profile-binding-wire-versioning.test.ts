import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  downgradeResponseAcrossMajors,
  upgradeRequestToVersion,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/index";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/index";
import { chatSubscribeV144 } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ProfileBinding } from "@traycer/protocol/host/provider-profile-inheritance";
import {
  projectChatServerFrameForVersion,
  type ProjectedChatSubscribeServerFrame,
} from "../chat-frame-compat";

/**
 * `ChatRunSettings.profileBinding` is the portable account key a cross-host
 * clone reads. It first rides `chat.subscribe@1.44`, `epic.getChatRunSettings@4.2`,
 * `epic.getChatRunSettingsBatch@2.2`, `epic.create@1.5`, `epic.createChat@1.5`
 * and `epic.updateChatRunSettings@1.3`. Every line below those minors shipped
 * without it, so a peer on one must never receive the key: the stream by the
 * host's outbound projection, the unary reads by the response the negotiated
 * contract serializes, the requests by the older minor's own request schema.
 *
 * Each line is exercised through the real registry entry and the real
 * projection, and the result is read for the key by name anywhere in the
 * value, so a slot nobody listed cannot hide a leak.
 */

const KEY_BINDING: ProfileBinding = {
  kind: "key",
  key: { providerId: "claude-code", accountId: "acct-1", organizationId: null },
};
const UNIDENTIFIED_BINDING: ProfileBinding = { kind: "source-unidentified" };
const BINDINGS: ReadonlyArray<readonly [string, ProfileBinding]> = [
  ["a key binding", KEY_BINDING],
  ["an unidentified source", UNIDENTIFIED_BINDING],
];

const recordSchema = z.record(z.string(), z.unknown());

function asRecord(value: unknown, label: string): Record<string, unknown> {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) throw new Error(`expected object for ${label}`);
  return parsed.data;
}

function asArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`expected array for ${label}`);
  return value;
}

/** Whether `key` appears as a property name anywhere inside `value`. */
function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
  const record = recordSchema.safeParse(value);
  if (!record.success) return false;
  return (
    Object.hasOwn(record.data, key) ||
    Object.values(record.data).some((item) => containsKey(item, key))
  );
}

function hasBinding(value: unknown): boolean {
  return containsKey(value, "profileBinding");
}

function isProjectedFrame(
  value: unknown,
): value is ProjectedChatSubscribeServerFrame {
  const record = recordSchema.safeParse(value);
  return (
    record.success &&
    typeof record.data.kind === "string" &&
    record.data.hasBinaryPayload === false
  );
}

function frameOf(value: unknown): ProjectedChatSubscribeServerFrame {
  if (!isProjectedFrame(value)) throw new Error("expected a text frame");
  return value;
}

// ─── chat.subscribe: every tuple slot a server frame carries ───────────────

const line = hostStreamRpcRegistry["chat.subscribe"][1];
const BINDING_MINOR = 44;
const WINDOWED_MINOR = 8;
const ULTRACODE_MINOR = 41;

const ALL_MINORS = Object.keys(line.versions)
  .map(Number)
  .sort((a, b) => a - b);
const OLD_MINORS = ALL_MINORS.filter((minor) => minor < BINDING_MINOR);
const NEW_MINORS = ALL_MINORS.filter((minor) => minor >= BINDING_MINOR);

function version(minor: number): { major: 1; minor: number } {
  return { major: 1, minor };
}

function tuple(
  model: string,
  binding: ProfileBinding | null,
): Record<string, unknown> {
  return {
    harnessId: "claude",
    model,
    permissionMode: "full_access",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId: "profile-1",
    ultracode: true,
    ...(binding === null ? {} : { profileBinding: binding }),
  };
}

/** Alternates the two binding kinds across slots so both are stripped. */
type Bindings = {
  readonly key: ProfileBinding | null;
  readonly unidentified: ProfileBinding | null;
};
function bindingsFor(bound: boolean): Bindings {
  return bound
    ? { key: KEY_BINDING, unidentified: UNIDENTIFIED_BINDING }
    : { key: null, unidentified: null };
}

const ENVELOPE = {
  hasBinaryPayload: false,
  epicId: "epic-1",
  chatId: "chat-1",
};
const SENDER = { type: "user", userId: "user-1" };
const CONTENT = { type: "doc", content: [] };

function promptItem(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "prompt",
    queueItemId: "queue-1",
    messageId: "user-1",
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    sender: SENDER,
    settings,
    accountContext: { type: "PERSONAL" },
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function pendingFallback(bindings: Bindings): Record<string, unknown> {
  return {
    traversalId: "traversal-1",
    revision: 3,
    state: "choosing",
    reason: "rate_limited",
    failedTuple: tuple("claude-sonnet-5", bindings.key),
    targetTuple: tuple("claude-opus-5", bindings.key),
    impendingAction: {
      planId: "plan-1",
      rung: "profile",
      target: tuple("claude-opus-5", bindings.unidentified),
      targetModelFamily: null,
      resumesAt: null,
      pending: null,
    },
    deadline: 1_700_000_000_000,
    graceRemainingMs: 5_000,
    attempt: 2,
    maxAttempts: 5,
    queuedItemsMoving: 4,
    siblingSwitching: 1,
  };
}

function pendingReturn(bindings: Bindings): Record<string, unknown> {
  return {
    traversalId: "traversal-return-1",
    revision: 4,
    preferredTuple: tuple("claude-sonnet-5", bindings.key),
    fallbackTuple: tuple("claude-opus-5", bindings.unidentified),
    queuedItemsMoving: 2,
    offeredAt: 1_700_000_000_000,
  };
}

function lastFailedAttempt(bindings: Bindings): Record<string, unknown> {
  return {
    userMessageId: "user-message-1",
    turnId: "turn-1",
    failure: {
      reason: "rate_limit",
      resetsAt: 1_700_000_600_000,
      resetsAtSource: "provider",
      scope: "five_hour",
      providerDetail: "code=rate_limit_exceeded",
    },
    eligibleRungs: ["retry", "switch", "wait_once"],
    waitDisposition: "eligible",
    switchDisposition: "eligible",
    failedTuple: tuple("claude-sonnet-5", bindings.key),
    waitResumesAt: 1_700_000_705_000,
  };
}

const ACCESS = { role: "owner", ownerUserId: "user-1", canAct: true };

function queueOf(bindings: Bindings): Record<string, unknown> {
  return {
    status: "idle",
    items: [promptItem(tuple("claude-sonnet-5", bindings.unidentified))],
  };
}

function windowedSnapshot(bound: boolean): ProjectedChatSubscribeServerFrame {
  const bindings = bindingsFor(bound);
  return frameOf({
    kind: "snapshot",
    ...ENVELOPE,
    snapshot: {
      chat: {
        parentId: null,
        id: "chat-1",
        userId: "user-1",
        hostId: "host-1",
        title: "Chat",
        createdAt: 1000,
        updatedAt: 1000,
        isTitleEditedByUser: false,
        settings: tuple("claude-sonnet-5", bindings.key),
      },
      access: ACCESS,
      queue: queueOf(bindings),
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
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
      pendingFallback: pendingFallback(bindings),
      pendingReturn: pendingReturn(bindings),
      lastFailedAttempt: lastFailedAttempt(bindings),
    },
  });
}

/** The pre-windowed carrier: lines below `1.8` send the whole chat record. */
function legacySnapshot(bound: boolean): ProjectedChatSubscribeServerFrame {
  const bindings = bindingsFor(bound);
  return frameOf({
    kind: "snapshot",
    ...ENVELOPE,
    snapshot: {
      chat: {
        parentId: null,
        id: "chat-1",
        userId: "user-1",
        hostId: "test-host",
        title: "Chat",
        createdAt: 1000,
        updatedAt: 1000,
        isTitleEditedByUser: false,
        settings: tuple("claude-sonnet-5", bindings.key),
        events: [],
        activeSessionChain: null,
        claudePendingWakes: [],
        messages: [],
        archivedAt: null,
        pinnedUserProviderHandle: null,
        lastDeliveredRolesDigest: null,
      },
      access: ACCESS,
      queue: { status: "idle", items: [] },
      activeTurn: null,
      runStatus: "idle",
      pendingApprovals: [],
      pendingInterviews: [],
      pendingFileEditApprovals: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      accumulatedFileChanges: [],
    },
  });
}

function queueChanged(bound: boolean): ProjectedChatSubscribeServerFrame {
  return frameOf({
    kind: "queueChanged",
    ...ENVELOPE,
    queue: queueOf(bindingsFor(bound)),
  });
}

function turnStateChanged(bound: boolean): ProjectedChatSubscribeServerFrame {
  const bindings = bindingsFor(bound);
  return frameOf({
    kind: "turnStateChanged",
    ...ENVELOPE,
    runStatus: "running",
    activeTurn: null,
    pendingFallback: pendingFallback(bindings),
    pendingReturn: pendingReturn(bindings),
    lastFailedAttempt: lastFailedAttempt(bindings),
  });
}

type Carrier = {
  readonly name: string;
  readonly build: (bound: boolean) => ProjectedChatSubscribeServerFrame;
  /** Whether the line at `minor` serves this carrier at all. */
  readonly availableAt: (minor: number) => boolean;
  /** Whether this fixture is known to decode on the line at `minor`. */
  readonly decodesAt: (minor: number) => boolean;
  /** The tuple slots the carrier holds. */
  readonly slotCount: number;
};

const CARRIERS: readonly Carrier[] = [
  {
    name: "a windowed snapshot",
    build: windowedSnapshot,
    availableAt: (minor) => minor >= WINDOWED_MINOR,
    decodesAt: (minor) => minor >= WINDOWED_MINOR,
    slotCount: 8,
  },
  {
    name: "a legacy snapshot",
    build: legacySnapshot,
    availableAt: (minor) => minor < WINDOWED_MINOR,
    decodesAt: (minor) => minor < WINDOWED_MINOR,
    slotCount: 1,
  },
  {
    name: "a queueChanged frame",
    build: queueChanged,
    availableAt: () => true,
    decodesAt: (minor) => minor >= WINDOWED_MINOR,
    slotCount: 1,
  },
  {
    name: "a turnStateChanged frame",
    build: turnStateChanged,
    availableAt: () => true,
    decodesAt: (minor) => minor >= WINDOWED_MINOR,
    slotCount: 6,
  },
];

/** Every settings tuple the frame carries, keyed by where it sits. */
function tupleSlots(frame: unknown): Record<string, unknown> {
  const root = asRecord(frame, "frame");
  const body =
    root.kind === "snapshot" ? asRecord(root.snapshot, "snapshot") : root;
  const slots: Record<string, unknown> = {};
  if (root.kind === "snapshot") {
    slots.chat = asRecord(body.chat, "chat").settings;
  }
  if (body.queue !== undefined) {
    const items = asArray(asRecord(body.queue, "queue").items, "queue items");
    if (items.length > 0) {
      slots.queue = asRecord(items[0], "queue item").settings;
    }
  }
  if (body.pendingFallback !== undefined) {
    const fallback = asRecord(body.pendingFallback, "pendingFallback");
    slots.failed = fallback.failedTuple;
    slots.target = fallback.targetTuple;
    slots.impending = asRecord(
      fallback.impendingAction,
      "impendingAction",
    ).target;
  }
  if (body.pendingReturn !== undefined) {
    const pending = asRecord(body.pendingReturn, "pendingReturn");
    slots.preferred = pending.preferredTuple;
    slots.returnFallback = pending.fallbackTuple;
  }
  if (body.lastFailedAttempt !== undefined) {
    slots.lastFailed = asRecord(
      body.lastFailedAttempt,
      "lastFailedAttempt",
    ).failedTuple;
  }
  return slots;
}

function parseFrame(schema: z.ZodType, frame: unknown): unknown {
  const result = schema.safeParse(frame);
  if (!result.success) {
    throw new Error(
      `frame did not parse: ${JSON.stringify(
        result.error.issues
          .slice(0, 3)
          .map((issue) => ({ path: issue.path.join("."), why: issue.message })),
      )}`,
    );
  }
  return result.data;
}

const liveFrames = chatSubscribeV144.serverFrameSchema;

describe("a live chat.subscribe frame carries the binding in every tuple slot", () => {
  it.each(CARRIERS.filter((carrier) => carrier.availableAt(BINDING_MINOR)))(
    "$name",
    (carrier) => {
      const slots = tupleSlots(parseFrame(liveFrames, carrier.build(true)));
      expect(Object.keys(slots)).toHaveLength(carrier.slotCount);
      for (const [slot, value] of Object.entries(slots)) {
        expect(asRecord(value, slot).profileBinding, slot).toBeDefined();
      }
    },
  );

  it("keeps both binding kinds, not just the key", () => {
    const slots = tupleSlots(parseFrame(liveFrames, windowedSnapshot(true)));
    const kinds = Object.values(slots).map(
      (value) => asRecord(asRecord(value, "tuple").profileBinding, "b").kind,
    );
    expect(new Set(kinds)).toEqual(new Set(["key", "source-unidentified"]));
  });
});

const OLD_CASES = OLD_MINORS.map((minor) => ({
  minor,
  carriers: CARRIERS.filter((carrier) => carrier.availableAt(minor)),
}));

describe.each(OLD_CASES)("chat.subscribe@1.$minor", ({ minor, carriers }) => {
  const frames = line.versions[minor].contract.serverFrameSchema;

  describe.each(carriers)("projecting $name", (carrier) => {
    it("strips profileBinding from every slot, keeps the rest, and leaves the caller's frame", () => {
      const keyed = carrier.build(true);
      const before = structuredClone(keyed);

      const projected = projectChatServerFrameForVersion(keyed, version(minor));

      expect(hasBinding(projected)).toBe(false);
      // Everything around the binding is what a binding-free frame projects to.
      expect(projected).toEqual(
        projectChatServerFrameForVersion(carrier.build(false), version(minor)),
      );
      expect(keyed).toEqual(before);

      const slots = tupleSlots(projected);
      expect(Object.keys(slots)).toEqual(Object.keys(tupleSlots(keyed)));
      for (const [slot, value] of Object.entries(slots)) {
        // The Ultracode request has its own cliff at 1.41, which this one
        // must not move.
        expect(Object.hasOwn(asRecord(value, slot), "ultracode"), slot).toBe(
          minor >= ULTRACODE_MINOR,
        );
      }
    });

    if (carrier.decodesAt(minor)) {
      it("yields a frame the line decodes with no binding anywhere", () => {
        const projected = projectChatServerFrameForVersion(
          carrier.build(true),
          version(minor),
        );
        expect(hasBinding(parseFrame(frames, projected))).toBe(false);
      });

      it("decodes even an unprojected keyed frame without the binding", () => {
        expect(hasBinding(parseFrame(frames, carrier.build(true)))).toBe(false);
      });
    }
  });
});

const NEW_CASES = NEW_MINORS.map((minor) => ({
  minor,
  carriers: CARRIERS.filter((carrier) => carrier.availableAt(minor)),
}));

describe.each(NEW_CASES)("chat.subscribe@1.$minor", ({ minor, carriers }) => {
  const frames = line.versions[minor].contract.serverFrameSchema;

  describe.each(carriers)("carrying $name", (carrier) => {
    it("leaves a keyed frame unchanged when projected to the line", () => {
      const keyed = carrier.build(true);
      expect(projectChatServerFrameForVersion(keyed, version(minor))).toEqual(
        keyed,
      );
    });

    it("decodes every slot with its binding intact", () => {
      const keyed = carrier.build(true);
      const decoded = tupleSlots(parseFrame(frames, keyed));
      const sent = tupleSlots(keyed);
      expect(Object.keys(decoded)).toEqual(Object.keys(sent));
      for (const [slot, value] of Object.entries(decoded)) {
        expect(asRecord(value, slot).profileBinding, slot).toEqual(
          asRecord(sent[slot], slot).profileBinding,
        );
      }
    });
  });
});

// ─── Settings reads: the response the negotiated contract serializes ───────

const STORED = {
  harnessId: "claude",
  model: "claude-sonnet-4-20250514",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "epic",
  profileId: "profile-1",
  ultracode: true,
};

const GET_SETTINGS = hostRpcRegistry["epic.getChatRunSettings"];
const GET_BATCH = hostRpcRegistry["epic.getChatRunSettingsBatch"];

describe.each(BINDINGS)("epic.getChatRunSettings with %s", (_name, binding) => {
  const answer = { settings: { ...STORED, profileBinding: binding } };
  const frozenAnswer =
    GET_SETTINGS[4].versions[1].contract.responseSchema.parse(answer);

  it("@4.1 omits the binding and keeps the rest of the tuple", () => {
    expect(frozenAnswer.settings).toEqual(STORED);
  });

  it("@4.2 keeps the binding beside the rest of the tuple", () => {
    expect(
      GET_SETTINGS[4].versions[2].contract.responseSchema.parse(answer)
        .settings,
    ).toEqual({ ...STORED, profileBinding: binding });
  });

  it("answers a missing chat the same on both lines", () => {
    expect(
      GET_SETTINGS[4].versions[1].contract.responseSchema.parse({
        settings: null,
      }),
    ).toEqual({ settings: null });
    expect(
      GET_SETTINGS[4].versions[2].contract.responseSchema.parse({
        settings: null,
      }),
    ).toEqual({ settings: null });
  });

  it("upgrading a 4.1 answer to 4.2 does not invent a binding", () => {
    const upgraded = upgradeResponseToVersion(
      GET_SETTINGS,
      { major: 4, minor: 1 },
      { major: 4, minor: 2 },
      frozenAnswer,
    );
    expect(upgraded.settings).toEqual(STORED);
  });

  it("downgrading the live answer to every older major leaves no binding", () => {
    const live =
      GET_SETTINGS[4].versions[2].contract.responseSchema.parse(answer);
    // The answer being downgraded does carry the key, so absence is the bridge's.
    expect(hasBinding(live)).toBe(true);
    const downgrades = [
      downgradeResponseAcrossMajors(GET_SETTINGS, 4, 3, live),
      downgradeResponseAcrossMajors(GET_SETTINGS, 4, 2, live),
      downgradeResponseAcrossMajors(GET_SETTINGS, 4, 1, live),
    ];
    for (const downgraded of downgrades) {
      expect(downgraded.ok).toBe(true);
      if (!downgraded.ok) continue;
      expect(downgraded.value.settings).toMatchObject({
        harnessId: "claude",
        model: STORED.model,
        profileId: "profile-1",
      });
      expect(hasBinding(downgraded.value)).toBe(false);
    }
  });
});

describe.each(BINDINGS)(
  "epic.getChatRunSettingsBatch with %s",
  (_name, binding) => {
    const answer = {
      entries: [
        { chatId: "chat-1", settings: { ...STORED, profileBinding: binding } },
        { chatId: "chat-2", settings: null },
      ],
    };
    const frozenAnswer =
      GET_BATCH[2].versions[1].contract.responseSchema.parse(answer);

    it("@2.1 omits the binding from the entry that has one and keeps the null", () => {
      expect(frozenAnswer.entries).toEqual([
        { chatId: "chat-1", settings: STORED },
        { chatId: "chat-2", settings: null },
      ]);
    });

    it("@2.2 keeps the binding on that entry", () => {
      expect(
        GET_BATCH[2].versions[2].contract.responseSchema.parse(answer).entries,
      ).toEqual([
        {
          chatId: "chat-1",
          settings: { ...STORED, profileBinding: binding },
        },
        { chatId: "chat-2", settings: null },
      ]);
    });

    it("upgrading a 2.1 answer to 2.2 does not invent a binding", () => {
      const upgraded = upgradeResponseToVersion(
        GET_BATCH,
        { major: 2, minor: 1 },
        { major: 2, minor: 2 },
        frozenAnswer,
      );
      expect(hasBinding(upgraded)).toBe(false);
      expect(upgraded.entries).toHaveLength(2);
    });

    it("downgrading the live answer to major 1 leaves no binding", () => {
      const live =
        GET_BATCH[2].versions[2].contract.responseSchema.parse(answer);
      expect(hasBinding(live)).toBe(true);
      const downgraded = downgradeResponseAcrossMajors(GET_BATCH, 2, 1, live);
      expect(downgraded.ok).toBe(true);
      if (!downgraded.ok) return;
      expect(downgraded.value.entries).toHaveLength(2);
      expect(downgraded.value.entries[1]).toEqual({
        chatId: "chat-2",
        settings: null,
      });
      expect(hasBinding(downgraded.value)).toBe(false);
    });
  },
);

// ─── Requests: an older minor's own request schema drops the key ───────────

const EPIC_LIGHT = {
  id: "epic-1",
  title: "Epic",
  initialUserPrompt: "Do the thing",
  ticketCount: 0,
  specCount: 0,
  storyCount: 0,
  reviewCount: 0,
  status: "todo",
  createdAt: 1000,
  updatedAt: 1000,
  createdBy: "user-1",
  version: "2.0.0",
};
const OWNER = { kind: "team", teamId: "team-1" };
const OPENING = {
  messageId: "message-1",
  clientActionId: "action-1",
  content: CONTENT,
  sender: SENDER,
  accountContext: { type: "PERSONAL" },
};

function withBinding(binding: ProfileBinding): Record<string, unknown> {
  return { ...STORED, profileBinding: binding };
}

function createRequest(binding: ProfileBinding): Record<string, unknown> {
  return {
    epic: EPIC_LIGHT,
    repoIdentifiers: [],
    workspaces: [],
    owner: OWNER,
    chat: {
      chatId: "chat-1",
      parentId: null,
      hostId: "host-1",
      title: "First chat",
      worktreeIntent: null,
      initialMessage: { ...OPENING, settings: withBinding(binding) },
    },
  };
}

function createChatRequest(binding: ProfileBinding): Record<string, unknown> {
  return {
    epicId: "epic-1",
    parentId: null,
    hostId: "host-1",
    title: "Fork",
    chatId: "chat-2",
    settings: withBinding(binding),
    initialMessage: { ...OPENING, settings: withBinding(binding) },
  };
}

function updateRequest(binding: ProfileBinding): Record<string, unknown> {
  return {
    epicId: "epic-1",
    chatId: "chat-1",
    settings: withBinding(binding),
  };
}

const CREATE = hostRpcRegistry["epic.create"];
const CREATE_CHAT = hostRpcRegistry["epic.createChat"];
const UPDATE = hostRpcRegistry["epic.updateChatRunSettings"];

const CREATE_FROZEN: ReadonlyArray<readonly [string, z.ZodType]> = [
  ["1.0", CREATE[1].versions[0].contract.requestSchema],
  ["1.1", CREATE[1].versions[1].contract.requestSchema],
  ["1.2", CREATE[1].versions[2].contract.requestSchema],
  ["1.3", CREATE[1].versions[3].contract.requestSchema],
  ["1.4", CREATE[1].versions[4].contract.requestSchema],
];
const CREATE_CHAT_FROZEN: ReadonlyArray<readonly [string, z.ZodType]> = [
  ["1.0", CREATE_CHAT[1].versions[0].contract.requestSchema],
  ["1.1", CREATE_CHAT[1].versions[1].contract.requestSchema],
  ["1.2", CREATE_CHAT[1].versions[2].contract.requestSchema],
  ["1.3", CREATE_CHAT[1].versions[3].contract.requestSchema],
  ["1.4", CREATE_CHAT[1].versions[4].contract.requestSchema],
];
const UPDATE_FROZEN: ReadonlyArray<readonly [string, z.ZodType]> = [
  ["1.0", UPDATE[1].versions[0].contract.requestSchema],
  ["1.1", UPDATE[1].versions[1].contract.requestSchema],
  ["1.2", UPDATE[1].versions[2].contract.requestSchema],
];

describe.each(BINDINGS)("request slots with %s", (_name, binding) => {
  describe("epic.create", () => {
    it.each(CREATE_FROZEN)(
      "@%s drops the binding wherever it sits",
      (_v, schema) => {
        expect(hasBinding(parseFrame(schema, createRequest(binding)))).toBe(
          false,
        );
      },
    );

    it("@1.4 keeps the rest of the opening and the owner", () => {
      const parsed = CREATE[1].versions[4].contract.requestSchema.parse(
        createRequest(binding),
      );
      expect(parsed.chat?.initialMessage?.settings).toEqual(STORED);
      expect(parsed.owner).toEqual(OWNER);
    });

    it("@1.5 keeps the binding in the opening", () => {
      const parsed = CREATE[1].versions[5].contract.requestSchema.parse(
        createRequest(binding),
      );
      expect(parsed.chat?.initialMessage?.settings).toEqual({
        ...STORED,
        profileBinding: binding,
      });
      expect(parsed.owner).toEqual(OWNER);
    });

    it("upgrading a 1.4 request to 1.5 does not invent a binding", () => {
      const upgraded = upgradeRequestToVersion(
        CREATE,
        { major: 1, minor: 4 },
        { major: 1, minor: 5 },
        CREATE[1].versions[4].contract.requestSchema.parse(
          createRequest(binding),
        ),
      );
      expect(upgraded.chat?.initialMessage?.settings).toEqual(STORED);
    });
  });

  describe("epic.createChat", () => {
    it.each(CREATE_CHAT_FROZEN)(
      "@%s drops the binding wherever it sits",
      (_v, schema) => {
        expect(hasBinding(parseFrame(schema, createChatRequest(binding)))).toBe(
          false,
        );
      },
    );

    it("@1.4 keeps the rest of both settings slots", () => {
      const parsed = CREATE_CHAT[1].versions[4].contract.requestSchema.parse(
        createChatRequest(binding),
      );
      expect(parsed.settings).toEqual(STORED);
      expect(parsed.initialMessage?.settings).toEqual(STORED);
    });

    it("@1.5 keeps the binding in both settings slots", () => {
      const parsed = CREATE_CHAT[1].versions[5].contract.requestSchema.parse(
        createChatRequest(binding),
      );
      const expected = { ...STORED, profileBinding: binding };
      expect(parsed.settings).toEqual(expected);
      expect(parsed.initialMessage?.settings).toEqual(expected);
    });

    it("upgrading a 1.4 request to 1.5 does not invent a binding", () => {
      const upgraded = upgradeRequestToVersion(
        CREATE_CHAT,
        { major: 1, minor: 4 },
        { major: 1, minor: 5 },
        CREATE_CHAT[1].versions[4].contract.requestSchema.parse(
          createChatRequest(binding),
        ),
      );
      expect(upgraded.settings).toEqual(STORED);
      expect(upgraded.initialMessage?.settings).toEqual(STORED);
    });
  });

  describe("epic.updateChatRunSettings", () => {
    it.each(UPDATE_FROZEN)("@%s drops the binding", (_v, schema) => {
      expect(hasBinding(parseFrame(schema, updateRequest(binding)))).toBe(
        false,
      );
    });

    it("@1.2 keeps the rest of the whole-tuple replace", () => {
      expect(
        UPDATE[1].versions[2].contract.requestSchema.parse(
          updateRequest(binding),
        ),
      ).toEqual({ epicId: "epic-1", chatId: "chat-1", settings: STORED });
    });

    it("@1.3 keeps the binding", () => {
      expect(
        UPDATE[1].versions[3].contract.requestSchema.parse(
          updateRequest(binding),
        ),
      ).toEqual({
        epicId: "epic-1",
        chatId: "chat-1",
        settings: { ...STORED, profileBinding: binding },
      });
    });

    it("upgrading a 1.2 request to 1.3 does not invent a binding", () => {
      const upgraded = upgradeRequestToVersion(
        UPDATE,
        { major: 1, minor: 2 },
        { major: 1, minor: 3 },
        UPDATE[1].versions[2].contract.requestSchema.parse(
          updateRequest(binding),
        ),
      );
      expect(upgraded.settings).toEqual(STORED);
    });
  });
});
