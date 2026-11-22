import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import { openChatEventSchema } from "@traycer/protocol/host/agent/gui/open-harness-wire";
import { chatSchema } from "@traycer/protocol/persistence/epic/schemas";
import { chatEventSchema } from "@traycer/protocol/persistence/epic/chat-events";
import {
  projectChatServerFrameForVersion,
  type ProjectedChatSubscribeServerFrame,
} from "../chat-frame-compat";

/**
 * `ChatEvent.providerSelection` first rides `chat.subscribe@1.44`. Every
 * released line below it decodes events without the key, and the host's raw
 * outbound projection removes it for those peers. Minors are read off the
 * registry: a later minor is a `>= 44` line and keeps the key.
 *
 * A chat event rides four carriers: `eventAppended`, a legacy snapshot's
 * `chat.events` (below the windowed line), and a windowed snapshot's
 * `tail.events` and a `range` response's `events` (the windowed line and
 * above). Each line is exercised only through the carriers and actors it
 * accepts: a closed harness enum cannot name an arbitrary harness, so an open
 * unknown-harness actor is used from the open-harness line.
 */

const line = hostStreamRpcRegistry["chat.subscribe"][1];
const PROVENANCE_MINOR = 44;
const WINDOWED_MINOR = 8;
const OPEN_ACTOR_MINOR = 22;

const ALL_MINORS = Object.keys(line.versions)
  .map(Number)
  .sort((a, b) => a - b);
const OLD_MINORS = ALL_MINORS.filter((minor) => minor < PROVENANCE_MINOR);
const NEW_MINORS = ALL_MINORS.filter((minor) => minor >= PROVENANCE_MINOR);

const PROVIDER_SELECTION = {
  homeAddress: "home-1",
  bindingVersion: 3,
  holderRevision: "self",
  dispatchedAt: 1700,
};
// The event's `metadata` is an untyped caller bag, so a key of the same name
// INSIDE it is data, not the provenance field, and must survive every strip.
const METADATA = { providerSelection: "a metadata key, not the field" };

function version(minor: number): { major: 1; minor: number } {
  return { major: 1, minor };
}

const recordSchema = z.record(z.string(), z.unknown());

function asRecord(value: unknown, label: string): Record<string, unknown> {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) throw new Error(`expected object for ${label}`);
  return parsed.data;
}

function has(value: unknown, key: string): boolean {
  return Object.hasOwn(asRecord(value, `object with ${key}`), key);
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    const parsed = recordSchema.safeParse(current);
    if (!parsed.success) return undefined;
    current = parsed.data[key];
  }
  return current;
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

type Actor = {
  readonly name: string;
  readonly value: Record<string, unknown>;
  /** Whether the line's own harness rules let this actor parse at all. */
  readonly parsesAt: (minor: number) => boolean;
};

function agentSender(harnessId: string): Record<string, unknown> {
  return {
    type: "agent",
    harnessId,
    agentId: "agent-1",
    displayName: null,
    reply: { expectsReply: false },
    inReplyTo: null,
  };
}

const ACTORS: readonly Actor[] = [
  {
    name: "a user actor",
    value: { type: "user", userId: "user-1" },
    parsesAt: () => true,
  },
  {
    // A harness every released line's closed enum names.
    name: "a known-harness agent actor",
    value: agentSender("claude"),
    parsesAt: () => true,
  },
  {
    // The closed enum cannot name an arbitrary harness; the open-harness line
    // (1.22) reopened the actor leaf. Below it this actor must keep failing, for
    // its own reason and independently of `providerSelection`.
    name: "an unknown-harness agent actor",
    value: agentSender("acme-future-harness"),
    parsesAt: (minor) => minor >= OPEN_ACTOR_MINOR,
  },
];

function chatEvent(
  eventId: string,
  actor: Record<string, unknown>,
  withSelection: boolean,
): Record<string, unknown> {
  return {
    eventId,
    // Present in every line's event-type enum, `chat.imported` is not.
    type: "turn.started",
    timestamp: 1001,
    clientActionId: "action-1",
    actor,
    message: "Turn started",
    turnId: "turn-1",
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: METADATA,
    ...(withSelection ? { providerSelection: PROVIDER_SELECTION } : {}),
  };
}

const IDS = { epicId: "epic-1", chatId: "chat-1" };

const LEGACY_CHAT = {
  parentId: null,
  id: "chat-1",
  userId: "user-1",
  hostId: "test-host",
  title: "Chat",
  createdAt: 1000,
  updatedAt: 1000,
  isTitleEditedByUser: false,
  settings: null,
  activeSessionChain: null,
  claudePendingWakes: [],
  messages: [],
  archivedAt: null,
  pinnedUserProviderHandle: null,
  lastDeliveredRolesDigest: null,
};

const WINDOWED_CHAT = {
  parentId: null,
  id: "chat-1",
  userId: "user-1",
  hostId: "host-1",
  title: "Chat",
  createdAt: 1000,
  updatedAt: 1000,
  isTitleEditedByUser: false,
};

const WINDOWED_DERIVED = {
  latestAssistantUsage: null,
  pinnedTodo: null,
  pinnedTaskTodoItems: [],
  latestForkableAssistantMessageId: null,
  restorableSetupInterruption: null,
  interviewAnswerability: [],
  latestAssistantAuthFailureTurnKey: null,
  setupCardWindows: [],
};

type Events = readonly Record<string, unknown>[];

type Carrier = {
  readonly name: string;
  /** Where the carrier's events sit on a frame; a single event for `eventAppended`. */
  readonly path: readonly string[];
  readonly single: boolean;
  readonly build: (events: Events) => ProjectedChatSubscribeServerFrame;
  /** Whether the line at `minor` can deliver a chat event this way at all. */
  readonly availableAt: (minor: number) => boolean;
};

function legacySnapshot(events: Events): ProjectedChatSubscribeServerFrame {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    ...IDS,
    snapshot: {
      chat: { ...LEGACY_CHAT, events },
      access: { role: "owner", ownerUserId: "user-1", canAct: true },
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
  };
}

function windowedSnapshot(events: Events): ProjectedChatSubscribeServerFrame {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    ...IDS,
    snapshot: {
      chat: WINDOWED_CHAT,
      access: { role: "owner", ownerUserId: "user-1", canAct: true },
      queue: { status: "idle", items: [] },
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
      tail: { fromOrdinal: 0, messages: [], events },
      derived: WINDOWED_DERIVED,
    },
  };
}

const CARRIERS: readonly Carrier[] = [
  {
    name: "eventAppended",
    path: ["event"],
    single: true,
    build: (events) => ({
      kind: "eventAppended",
      hasBinaryPayload: false,
      ...IDS,
      event: events[0],
    }),
    availableAt: () => true,
  },
  {
    name: "a legacy snapshot's chat.events",
    path: ["snapshot", "chat", "events"],
    single: false,
    build: legacySnapshot,
    availableAt: (minor) => minor < WINDOWED_MINOR,
  },
  {
    name: "a windowed snapshot's tail.events",
    path: ["snapshot", "tail", "events"],
    single: false,
    build: windowedSnapshot,
    availableAt: (minor) => minor >= WINDOWED_MINOR,
  },
  {
    name: "a range response's events",
    path: ["range", "events"],
    single: false,
    build: (events) => ({
      kind: "range",
      hasBinaryPayload: false,
      ...IDS,
      range: {
        requestId: "range-1",
        epoch: 0,
        fromOrdinal: 0,
        rowIds: [],
        messages: [],
        events,
        reachedStart: true,
        reachedEnd: true,
      },
    }),
    availableAt: (minor) => minor >= WINDOWED_MINOR,
  },
];

/** The events a carrier holds on `frame`, or `undefined` when it holds none. */
function eventsAt(
  frame: unknown,
  carrier: Carrier,
): readonly unknown[] | undefined {
  const found = valueAt(frame, carrier.path);
  if (carrier.single) return found === undefined ? undefined : [found];
  return Array.isArray(found) ? found : undefined;
}

type Parsed =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly why: string };

function parse(schema: z.ZodType, frame: unknown): Parsed {
  const result = schema.safeParse(frame);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    why: JSON.stringify(
      result.error.issues
        .slice(0, 3)
        .map((issue) => ({ path: issue.path.join("."), why: issue.message })),
    ),
  };
}

function parsedOk(parsed: Parsed): unknown {
  if (!parsed.ok) throw new Error(`frame did not parse: ${parsed.why}`);
  return parsed.data;
}

const OLD_CASES = OLD_MINORS.map((minor) => ({
  minor,
  carriers: CARRIERS.filter((carrier) => carrier.availableAt(minor)),
  actors: ACTORS.filter((actor) => actor.parsesAt(minor)),
}));

describe.each(OLD_CASES)(
  "chat.subscribe@1.$minor",
  ({ minor, carriers, actors }) => {
    const { contract } = line.versions[minor];
    const frames = contract.serverFrameSchema;

    describe.each(carriers)("decoding $name", (carrier) => {
      it.each(actors)(
        "drops providerSelection and keeps the rest of an event from $name",
        (actor) => {
          const plain = parsedOk(
            parse(
              frames,
              carrier.build([chatEvent("event-1", actor.value, false)]),
            ),
          );
          const keyed = parsedOk(
            parse(
              frames,
              carrier.build([chatEvent("event-1", actor.value, true)]),
            ),
          );

          const keyedEvents = eventsAt(keyed, carrier);
          expect(keyedEvents).toHaveLength(1);
          expect(has(keyedEvents?.[0], "providerSelection")).toBe(false);
          expect(keyedEvents).toEqual(eventsAt(plain, carrier));
          expect(keyedEvents?.[0]).toMatchObject({ metadata: METADATA });
        },
      );
    });

    describe.each(carriers)("projecting $name", (carrier) => {
      it("strips providerSelection from every event, leaves metadata and the caller's frame, and yields a frame the line decodes", () => {
        const keyed = carrier.build([
          chatEvent("event-1", ACTORS[0].value, true),
          chatEvent("event-2", ACTORS[1].value, true),
        ]);
        const plain = carrier.build([
          chatEvent("event-1", ACTORS[0].value, false),
          chatEvent("event-2", ACTORS[1].value, false),
        ]);
        const before = structuredClone(keyed);

        const projected = projectChatServerFrameForVersion(
          keyed,
          version(minor),
        );

        const events = eventsAt(projected, carrier);
        expect(events).toHaveLength(carrier.single ? 1 : 2);
        for (const event of events ?? []) {
          expect(has(event, "providerSelection")).toBe(false);
          expect(valueAt(event, ["metadata"])).toEqual(METADATA);
        }
        expect(projected).toEqual(
          projectChatServerFrameForVersion(plain, version(minor)),
        );
        expect(keyed).toEqual(before);
        parsedOk(parse(frames, projected));
      });
    });
  },
);

const NEW_CASES = NEW_MINORS.map((minor) => ({
  minor,
  carriers: CARRIERS.filter((carrier) => carrier.availableAt(minor)),
}));

describe.each(NEW_CASES)("chat.subscribe@1.$minor", ({ minor, carriers }) => {
  const frames = line.versions[minor].contract.serverFrameSchema;

  describe.each(carriers)("decoding $name", (carrier) => {
    it.each(ACTORS)(
      "keeps providerSelection from $name and accepts an event without it",
      (actor) => {
        const keyed = eventsAt(
          parsedOk(
            parse(
              frames,
              carrier.build([chatEvent("event-1", actor.value, true)]),
            ),
          ),
          carrier,
        );
        const plain = eventsAt(
          parsedOk(
            parse(
              frames,
              carrier.build([chatEvent("event-1", actor.value, false)]),
            ),
          ),
          carrier,
        );

        expect(keyed?.[0]).toMatchObject({
          providerSelection: PROVIDER_SELECTION,
          metadata: METADATA,
        });
        expect(has(plain?.[0], "providerSelection")).toBe(false);
      },
    );

    it("leaves a keyed frame unchanged when projected to the line", () => {
      const keyed = carrier.build([
        chatEvent("event-1", ACTORS[0].value, true),
      ]);

      expect(projectChatServerFrameForVersion(keyed, version(minor))).toEqual(
        keyed,
      );
    });
  });
});

describe("the persisted and live chat event keep providerSelection", () => {
  it.each([
    ["chatEventSchema", chatEventSchema],
    ["openChatEventSchema", openChatEventSchema],
  ] as const)(
    "%s keeps it and accepts an event without it",
    (_name, schema) => {
      const keyed = schema.parse(chatEvent("event-1", ACTORS[1].value, true));
      const plain = schema.parse(chatEvent("event-1", ACTORS[1].value, false));

      expect(keyed).toMatchObject({ providerSelection: PROVIDER_SELECTION });
      expect(has(plain, "providerSelection")).toBe(false);
    },
  );

  it("openChatEventSchema keeps it on an actor the closed enum does not name", () => {
    expect(
      openChatEventSchema.parse(chatEvent("event-1", ACTORS[2].value, true)),
    ).toMatchObject({ providerSelection: PROVIDER_SELECTION });
  });

  it("the chat record keeps it on its event log", () => {
    const parsed = chatSchema.parse({
      ...LEGACY_CHAT,
      events: [chatEvent("event-1", ACTORS[0].value, true)],
    });

    expect(parsed.events[0]).toMatchObject({
      providerSelection: PROVIDER_SELECTION,
    });
  });
});
