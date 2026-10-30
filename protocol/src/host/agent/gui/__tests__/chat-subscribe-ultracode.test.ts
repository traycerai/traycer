import { describe, expect, it } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  chatSubscribeClientFrameSchema,
  chatSubscribeV136,
  chatSubscribeV140,
  chatSubscribeV141,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  epicCreateChatUpgradeV13ToV14,
  epicCreateChatV13,
  epicCreateChatV14,
  epicGetChatRunSettingsBatchDowngradeV21ToV10,
  epicGetChatRunSettingsBatchV21,
  epicGetChatRunSettingsDowngradeV41ToV10,
  epicGetChatRunSettingsDowngradeV41ToV20,
  epicGetChatRunSettingsDowngradeV41ToV30,
  epicGetChatRunSettingsUpgradeV40ToV41,
  epicGetChatRunSettingsV40,
  epicGetChatRunSettingsV41,
  epicUpdateChatRunSettingsUpgradeV11ToV12,
  epicUpdateChatRunSettingsV11,
  epicUpdateChatRunSettingsV12,
} from "@traycer/protocol/host/epic/contracts";
import {
  createChatInitialMessageSchemaV14,
  createEpicChatSeedSchemaV14,
} from "@traycer/protocol/host/epic/unary-schemas";
import { chatRunSettingsSchema } from "@traycer/protocol/persistence/epic/foundation";
import {
  chatRunSettingsStrictSchemaPreUltracode,
  chatRunSettingsStrictSchema,
} from "@traycer/protocol/persistence/epic/foundation";
import {
  chatLineCarriesUltracode,
  projectChatClientFrameForVersion,
  projectChatServerFrameForVersion,
  type ProjectedChatSubscribeServerFrame,
} from "../chat-frame-compat";

/**
 * `chat.subscribe@1.41` (with `epic.createChat`/`epic.create` 1.4,
 * `epic.updateChatRunSettings` 1.2, `epic.getChatRunSettings` 4.1 and its batch
 * 2.1) carries the per-chat Ultracode request. Every older line is frozen
 * without it: it parses, projects and downgrades to `false`/absent, and no
 * frame, request or response below 1.41 carries the key.
 */

const line = hostStreamRpcRegistry["chat.subscribe"][1];

const V140: SchemaVersion = { major: 1, minor: 40 };
const V141: SchemaVersion = { major: 1, minor: 41 };

type DiscriminatedFrameSchema = {
  readonly options: readonly {
    readonly shape: {
      readonly kind: { readonly values: Iterable<string> };
    };
  }[];
};

function frameKinds(schema: DiscriminatedFrameSchema): string[] {
  return [
    ...new Set(
      schema.options.flatMap((option) => [...option.shape.kind.values]),
    ),
  ].sort();
}

const OWNER = {
  hasBinaryPayload: false as const,
  epicId: "epic-1",
  chatId: "chat-1",
  clientActionId: "action-1",
};

const BASE_SETTINGS = {
  harnessId: "claude",
  model: "claude-sonnet-4-20250514",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

const STRICT_SETTINGS = BASE_SETTINGS;

const SENDER = { type: "user", userId: "user-1" };
const CONTENT = { type: "doc", content: [] };
const ACCOUNT = { type: "PERSONAL" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`expected object for ${label}`);
  return value;
}

function hasUltracode(value: unknown): boolean {
  return isRecord(value) && Object.hasOwn(value, "ultracode");
}

function ultracodeOf(value: unknown): unknown {
  return asRecord(value, "settings").ultracode;
}

type MutationKind =
  | "send"
  | "editUserMessage"
  | "queueSettingsUpdate"
  | "queueSettingsRestamp"
  | "queueSteerNow";

const MUTATIONS: readonly MutationKind[] = [
  "send",
  "editUserMessage",
  "queueSettingsUpdate",
  "queueSettingsRestamp",
  "queueSteerNow",
];

function rawMutation(
  kind: MutationKind,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  switch (kind) {
    case "send":
      return {
        kind,
        ...OWNER,
        messageId: "message-1",
        content: CONTENT,
        sender: SENDER,
        settings,
        accountContext: ACCOUNT,
        browserAnnotations: [],
      };
    case "editUserMessage":
      return {
        kind,
        ...OWNER,
        targetMessageId: "message-0",
        messageId: "message-1",
        content: CONTENT,
        sender: SENDER,
        settings,
        accountContext: ACCOUNT,
        revertFileChanges: false,
        browserAnnotations: [],
      };
    case "queueSettingsUpdate":
      return {
        kind,
        ...OWNER,
        queueItemId: "queue-1",
        settings,
        accountContext: ACCOUNT,
      };
    case "queueSettingsRestamp":
      return {
        kind,
        ...OWNER,
        settings,
        accountContext: ACCOUNT,
        excludeQueueItemId: null,
      };
    case "queueSteerNow":
      return { kind, ...OWNER, queueItemId: "queue-1", newSettings: settings };
  }
}

/** The tuple a mutation frame carries, wherever its kind keeps it. */
function carriedSettings(frame: unknown): unknown {
  const record = asRecord(frame, "frame");
  return record.kind === "queueSteerNow" ? record.newSettings : record.settings;
}

describe("chat.subscribe 1.41 registration", () => {
  it("binds chatSubscribeV141 at the head above the frozen 1.40", () => {
    expect(line.latestMinor).toBe(41);
    expect(line.versions[41].contract).toBe(chatSubscribeV141);
    expect(line.versions[40].contract).toBe(chatSubscribeV140);
    expect(chatSubscribeV141.schemaVersion).toEqual(V141);
  });

  it("keeps both frame directions on the same discriminants as frozen 1.40", () => {
    const frozen = chatSubscribeV140;
    const live = chatSubscribeV141;

    expect(frameKinds(live.serverFrameSchema)).toEqual(
      frameKinds(frozen.serverFrameSchema),
    );
    expect(frameKinds(live.clientFrameSchema)).toEqual(
      frameKinds(frozen.clientFrameSchema),
    );
  });

  it("reports the request on 1.41 and not on 1.40 or an unnegotiated peer", () => {
    expect(chatLineCarriesUltracode(V141)).toBe(true);
    expect(chatLineCarriesUltracode(V140)).toBe(false);
    expect(chatLineCarriesUltracode(null)).toBe(false);
  });
});

describe("P1: the per-chat tuple", () => {
  it("defaults an absent request to false and round-trips true", () => {
    expect(ultracodeOf(chatRunSettingsSchema.parse(BASE_SETTINGS))).toBe(false);
    expect(
      ultracodeOf(
        chatRunSettingsSchema.parse({ ...BASE_SETTINGS, ultracode: true }),
      ),
    ).toBe(true);
  });

  it("is required on the 1.2 strict tuple and absent from the frozen strict tuple", () => {
    expect(chatRunSettingsStrictSchema.safeParse(STRICT_SETTINGS).success).toBe(
      false,
    );
    expect(
      hasUltracode(
        chatRunSettingsStrictSchemaPreUltracode.parse({
          ...STRICT_SETTINGS,
          ultracode: true,
        }),
      ),
    ).toBe(false);
  });
});

describe("P4: older client settings frames materialize false", () => {
  it.each(MUTATIONS)(
    "a %s frame without the key, read on 1.40 then re-parsed live, carries false",
    (kind) => {
      const frozen = chatSubscribeV140.clientFrameSchema.parse(
        rawMutation(kind, BASE_SETTINGS),
      );
      const live = chatSubscribeClientFrameSchema.parse(frozen);
      expect(ultracodeOf(carriedSettings(live))).toBe(false);
    },
  );

  it.each(MUTATIONS)(
    "a %s frame carrying true is stripped by the frozen 1.40 parse, so the live re-parse is false, while 1.41 keeps it",
    (kind) => {
      const raw = rawMutation(kind, { ...BASE_SETTINGS, ultracode: true });
      const frozen = chatSubscribeV140.clientFrameSchema.parse(raw);
      expect(hasUltracode(carriedSettings(frozen))).toBe(false);
      expect(
        ultracodeOf(
          carriedSettings(chatSubscribeClientFrameSchema.parse(frozen)),
        ),
      ).toBe(false);
      expect(
        ultracodeOf(
          carriedSettings(chatSubscribeV141.clientFrameSchema.parse(raw)),
        ),
      ).toBe(true);
    },
  );

  it("strips the request on every older line that still parses the send frame", () => {
    const raw = rawMutation("send", { ...BASE_SETTINGS, ultracode: true });
    const minors = Object.keys(line.versions)
      .map(Number)
      .filter((minor) => minor <= 40);
    // 36 through 40 share the sibling shape and must all accept it.
    for (const minor of [36, 37, 38, 39, 40]) {
      expect(minors).toContain(minor);
    }
    for (const minor of minors) {
      const contract =
        line.versions[minor as keyof typeof line.versions]?.contract;
      if (contract === undefined) continue;
      const parsed = contract.clientFrameSchema.safeParse(raw);
      if (parsed.success) {
        expect(hasUltracode(carriedSettings(parsed.data))).toBe(false);
      } else {
        expect(minor).toBeLessThan(36);
      }
    }
    expect(chatSubscribeV136.clientFrameSchema.safeParse(raw).success).toBe(
      true,
    );
  });
});

describe("P6: client mutations are projected below 1.41", () => {
  it.each(MUTATIONS)(
    "%s drops the request on 1.40 and keeps it on 1.41",
    (kind) => {
      const frame = chatSubscribeClientFrameSchema.parse(
        rawMutation(kind, { ...BASE_SETTINGS, ultracode: true }),
      );
      expect(
        hasUltracode(
          carriedSettings(projectChatClientFrameForVersion(frame, V140)),
        ),
      ).toBe(false);
      expect(
        ultracodeOf(
          carriedSettings(projectChatClientFrameForVersion(frame, V141)),
        ),
      ).toBe(true);
    },
  );

  it("leaves a frame without a settings tuple untouched", () => {
    const frame = chatSubscribeClientFrameSchema.parse({
      kind: "resumeQueue",
      ...OWNER,
    });
    expect(projectChatClientFrameForVersion(frame, V140)).toEqual(frame);
  });
});

function promptItem(ultracode: boolean): Record<string, unknown> {
  return {
    kind: "prompt",
    queueItemId: "queue-1",
    messageId: "user-1",
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    sender: SENDER,
    settings: { ...BASE_SETTINGS, ultracode },
    accountContext: ACCOUNT,
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function queueChanged(ultracode: boolean): ProjectedChatSubscribeServerFrame {
  const parsed = chatSubscribeV141.serverFrameSchema.parse({
    kind: "queueChanged",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    queue: { status: "idle", items: [promptItem(ultracode)] },
  });
  if (parsed.kind !== "queueChanged") throw new Error("expected queueChanged");
  return parsed;
}

function firstQueuedSettings(frame: unknown): unknown {
  const queue = asRecord(asRecord(frame, "frame").queue, "queue");
  if (!Array.isArray(queue.items)) throw new Error("expected queue items");
  return asRecord(queue.items[0], "queue item").settings;
}

describe("P5: server frames are projected below 1.41", () => {
  it("drops the request from queued prompt items on 1.40, keeps it on 1.41, and the projection still parses on the frozen line", () => {
    const frame = queueChanged(true);

    const projected = projectChatServerFrameForVersion(frame, V140);
    expect(hasUltracode(firstQueuedSettings(projected))).toBe(false);
    expect(chatSubscribeV140.serverFrameSchema.parse(projected).kind).toBe(
      "queueChanged",
    );

    expect(
      ultracodeOf(
        firstQueuedSettings(projectChatServerFrameForVersion(frame, V141)),
      ),
    ).toBe(true);
  });

  it("is not a no-op for a false request either: the key is absent below 1.41", () => {
    const projected = projectChatServerFrameForVersion(
      queueChanged(false),
      V140,
    );
    expect(hasUltracode(firstQueuedSettings(projected))).toBe(false);
  });

  it("carries the request on the live parse and refuses it nowhere on 1.41", () => {
    expect(ultracodeOf(firstQueuedSettings(queueChanged(true)))).toBe(true);
    expect(
      hasUltracode(
        firstQueuedSettings(
          chatSubscribeV140.serverFrameSchema.parse(queueChanged(true)),
        ),
      ),
    ).toBe(false);
  });
});

describe("P2: epic.updateChatRunSettings upgrades materialize false", () => {
  it("1.1's strict tuple becomes 1.2's with the request false", () => {
    const request = epicUpdateChatRunSettingsV11.requestSchema.parse({
      epicId: "epic-1",
      chatId: "chat-1",
      settings: STRICT_SETTINGS,
    });
    const upgraded =
      epicUpdateChatRunSettingsUpgradeV11ToV12.upgradeRequest(request);
    expect(ultracodeOf(upgraded.settings)).toBe(false);
    expect(
      epicUpdateChatRunSettingsV12.requestSchema.safeParse(upgraded).success,
    ).toBe(true);
  });

  it("1.2 carries true and refuses a tuple that omits the key", () => {
    expect(
      ultracodeOf(
        epicUpdateChatRunSettingsV12.requestSchema.parse({
          epicId: "epic-1",
          chatId: "chat-1",
          settings: { ...STRICT_SETTINGS, ultracode: true },
        }).settings,
      ),
    ).toBe(true);
    expect(
      epicUpdateChatRunSettingsV12.requestSchema.safeParse({
        epicId: "epic-1",
        chatId: "chat-1",
        settings: STRICT_SETTINGS,
      }).success,
    ).toBe(false);
  });
});

describe("P8: reads of a chat's settings", () => {
  const stored = { ...BASE_SETTINGS, ultracode: true };

  it("upgrades a 4.0 answer to 4.1 with the request false", () => {
    const answer = epicGetChatRunSettingsV40.responseSchema.parse({
      settings: BASE_SETTINGS,
    });
    expect(
      ultracodeOf(
        epicGetChatRunSettingsUpgradeV40ToV41.upgradeResponse(answer).settings,
      ),
    ).toBe(false);
  });

  it.each([
    ["3.0", epicGetChatRunSettingsDowngradeV41ToV30],
    ["2.0", epicGetChatRunSettingsDowngradeV41ToV20],
    ["1.0", epicGetChatRunSettingsDowngradeV41ToV10],
  ] as const)(
    "downgrades a 4.1 answer to %s without the key",
    (_label, downgrade) => {
      const answer = epicGetChatRunSettingsV41.responseSchema.parse({
        settings: stored,
      });
      const result = downgrade.downgradeResponse(answer);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(hasUltracode(result.value.settings)).toBe(false);
    },
  );

  it("drops the key from every entry of a batch answer downgraded to 1.0", () => {
    const answer = epicGetChatRunSettingsBatchV21.responseSchema.parse({
      entries: [{ chatId: "chat-1", settings: stored }],
    });
    const result =
      epicGetChatRunSettingsBatchDowngradeV21ToV10.downgradeResponse(answer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries).toHaveLength(1);
    expect(hasUltracode(result.value.entries[0]?.settings)).toBe(false);
  });
});

const OPENING = {
  messageId: "message-1",
  clientActionId: "action-1",
  content: CONTENT,
  sender: SENDER,
  accountContext: ACCOUNT,
};

describe("P9: epic.createChat carries the request in both settings slots", () => {
  const request = (ultracode: boolean) => ({
    epicId: "epic-1",
    parentId: null,
    hostId: "host-1",
    title: "Fork",
    chatId: "chat-2",
    settings: { ...BASE_SETTINGS, ultracode },
    initialMessage: {
      ...OPENING,
      settings: { ...BASE_SETTINGS, ultracode },
    },
  });

  it("1.4 keeps true in the top-level settings and the opening", () => {
    const parsed = epicCreateChatV14.requestSchema.parse(request(true));
    expect(ultracodeOf(parsed.settings)).toBe(true);
    expect(ultracodeOf(parsed.initialMessage?.settings)).toBe(true);
  });

  it("1.3 strips true in both slots, and upgrading it yields false in both", () => {
    const old = epicCreateChatV13.requestSchema.parse(request(true));
    expect(hasUltracode(old.settings)).toBe(false);
    expect(hasUltracode(old.initialMessage?.settings)).toBe(false);

    const upgraded = epicCreateChatUpgradeV13ToV14.upgradeRequest(old);
    expect(ultracodeOf(upgraded.settings)).toBe(false);
    expect(ultracodeOf(upgraded.initialMessage?.settings)).toBe(false);
  });

  it("keeps the fork shape: a settings-only create without an opening still carries true", () => {
    const { initialMessage: _opening, ...withoutOpening } = request(true);
    const parsed = epicCreateChatV14.requestSchema.parse(withoutOpening);
    expect(ultracodeOf(parsed.settings)).toBe(true);
    expect(parsed.initialMessage).toBeUndefined();
  });
});

describe("P10: epic.create's folded chat seed carries the request", () => {
  const seed = (ultracode: boolean) => ({
    chatId: "chat-1",
    parentId: null,
    hostId: "host-1",
    title: "First chat",
    worktreeIntent: null,
    initialMessage: {
      ...OPENING,
      settings: { ...BASE_SETTINGS, ultracode },
    },
  });

  it("1.4's seed keeps true and defaults an absent key to false", () => {
    expect(
      ultracodeOf(
        createEpicChatSeedSchemaV14.parse(seed(true)).initialMessage?.settings,
      ),
    ).toBe(true);
    expect(
      ultracodeOf(
        createChatInitialMessageSchemaV14.parse({
          ...OPENING,
          settings: BASE_SETTINGS,
        }).settings,
      ),
    ).toBe(false);
  });
});
