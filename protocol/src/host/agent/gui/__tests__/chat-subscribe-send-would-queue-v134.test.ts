import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  chatSnapshotSchema,
  chatSubscribeServerFrameSchema,
  chatSubscribeV133,
  chatSubscribeV134,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";

/**
 * `chat.subscribe@1.34` carries the host's answer to "would a send queue
 * right now" as an optional `sendWouldQueue` on the snapshot, the windowed
 * snapshot, `turnStateChanged` and `queueChanged`.
 *
 * Hosts project this bit only to `1.34` peers. That peer keeps it as sent
 * (`true` and `false` both mean something, and absent means an older host), and
 * every frozen line `1.0`-`1.33` declares no such key, so it drops it as
 * unknown. A frozen line must never surface it, or a client reading the bit
 * would trust a host that never computed it.
 */

const line = hostStreamRpcRegistry["chat.subscribe"][1];
const MINORS = Object.keys(line.versions).map(Number);
const FIRST_WINDOWED_MINOR = 8;

const chat: Chat = {
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
  events: [],
  archivedAt: null,
  pinnedUserProviderHandle: null,
  lastDeliveredRolesDigest: null,
};

const envelope = {
  hasBinaryPayload: false,
  epicId: "epic-1",
  chatId: "chat-1",
};

const access = { role: "owner", ownerUserId: "user-1", canAct: true };

const fullSnapshot = {
  chat,
  access,
  queue: { status: "idle", items: [] },
  activeTurn: null,
  runStatus: "idle",
  pendingApprovals: [],
  pendingInterviews: [],
  pendingFileEditApprovals: [],
  worktreeBinding: null,
  missingWorktreePaths: [],
  accumulatedFileChanges: [],
  managedCommands: [],
};

const windowedSnapshot = {
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
  access,
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

type Surface = {
  readonly name: string;
  /** The frame as a peer on `minor` receives it, before `sendWouldQueue`. */
  readonly frame: (minor: number) => Record<string, unknown>;
  /** Reads the decoded bit off whichever frame the surface produced. */
  readonly read: (parsed: Record<string, unknown>) => unknown;
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected object for ${label}`);
  }
  return Object.fromEntries(Object.entries(value));
}

// `sendWouldQueue` sits INSIDE the snapshot, and at the frame root otherwise.
const SURFACES: readonly Surface[] = [
  {
    name: "snapshot",
    frame: (minor) => ({
      kind: "snapshot",
      ...envelope,
      snapshot: minor < FIRST_WINDOWED_MINOR ? fullSnapshot : windowedSnapshot,
    }),
    read: (parsed) => asRecord(parsed.snapshot, "snapshot").sendWouldQueue,
  },
  {
    name: "turnStateChanged",
    frame: () => ({
      kind: "turnStateChanged",
      ...envelope,
      runStatus: "idle",
      activeTurn: null,
    }),
    read: (parsed) => parsed.sendWouldQueue,
  },
  {
    name: "queueChanged",
    frame: () => ({
      kind: "queueChanged",
      ...envelope,
      queue: { status: "idle", items: [] },
    }),
    read: (parsed) => parsed.sendWouldQueue,
  },
];

/** Puts the bit where the surface carries it. */
function withBit(
  surface: Surface,
  minor: number,
  bit: unknown,
): Record<string, unknown> {
  const frame = surface.frame(minor);
  if (surface.name === "snapshot") {
    return {
      ...frame,
      snapshot: {
        ...asRecord(frame.snapshot, "snapshot"),
        sendWouldQueue: bit,
      },
    };
  }
  return { ...frame, sendWouldQueue: bit };
}

describe("chat.subscribe@1.34 registration", () => {
  it("binds chatSubscribeV134 above the frozen 1.33, the head has since moved to 1.38", () => {
    expect(line.latestMinor).toBe(39);
    expect(line.versions[34].contract).toBe(chatSubscribeV134);
    expect(line.versions[33].contract).toBe(chatSubscribeV133);
    expect(chatSubscribeV134.schemaVersion).toEqual({ major: 1, minor: 34 });
    expect(chatSubscribeV133.serverFrameSchema).not.toBe(
      chatSubscribeV134.serverFrameSchema,
    );
  });
});

describe("chat.subscribe@1.34 carries sendWouldQueue", () => {
  const { serverFrameSchema } = chatSubscribeV134;

  for (const surface of SURFACES) {
    describe(surface.name, () => {
      it.each([true, false])("keeps %s exactly as sent", (bit) => {
        const parsed = asRecord(
          serverFrameSchema.parse(withBit(surface, 34, bit)),
          "frame",
        );
        expect(surface.read(parsed)).toBe(bit);
      });

      it("stays absent when the host sent nothing", () => {
        const parsed = asRecord(
          serverFrameSchema.parse(surface.frame(34)),
          "frame",
        );
        expect(surface.read(parsed)).toBeUndefined();
      });

      it.each([null, "yes", 1])("refuses %j", (bit) => {
        expect(
          serverFrameSchema.safeParse(withBit(surface, 34, bit)).success,
        ).toBe(false);
      });
    });
  }
});

describe("the live full snapshot type", () => {
  it.each([true, false])(
    "keeps %s on chatSnapshotSchema and its frame",
    (bit) => {
      expect(
        chatSnapshotSchema.parse({ ...fullSnapshot, sendWouldQueue: bit })
          .sendWouldQueue,
      ).toBe(bit);
      const frame = chatSubscribeServerFrameSchema.parse({
        kind: "snapshot",
        ...envelope,
        snapshot: { ...fullSnapshot, sendWouldQueue: bit },
      });
      if (frame.kind !== "snapshot") throw new Error("expected snapshot");
      expect(frame.snapshot.sendWouldQueue).toBe(bit);
    },
  );

  it("parses without the key", () => {
    expect(chatSnapshotSchema.parse(fullSnapshot).sendWouldQueue).toBe(
      undefined,
    );
  });
});

describe("every frozen chat.subscribe line omits sendWouldQueue", () => {
  const frozenMinors = MINORS.filter((minor) => minor < 34);

  it("covers 1.0 through 1.33", () => {
    expect(frozenMinors).toEqual(Array.from({ length: 34 }, (_, i) => i));
  });

  for (const surface of SURFACES) {
    describe(surface.name, () => {
      it.each(frozenMinors)("1.%i strips the bit", (minor) => {
        const { serverFrameSchema } = line.versions[minor].contract;
        for (const bit of [true, false]) {
          const result = serverFrameSchema.safeParse(
            withBit(surface, minor, bit),
          );
          expect(result.success, `1.${minor} must still parse the frame`).toBe(
            true,
          );
          if (!result.success) return;
          expect(surface.read(asRecord(result.data, "frame"))).toBeUndefined();
        }
      });
    });
  }
});
