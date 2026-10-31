import { describe, expect, it } from "vitest";
import {
  epicCreateChatUpgradeV14ToV15,
  epicCreateChatV14,
  epicCreateChatV15,
  epicCreateUpgradeV14ToV15,
  epicCreateV14,
  epicCreateV15,
} from "@traycer/protocol/host/epic/contracts";
import {
  createChatInitialMessageSchemaV14,
  type CreateChatRequestV14,
  type CreateEpicRequestV14,
} from "@traycer/protocol/host/epic/unary-schemas";

// `@1.5` adds the browser-annotation sidecar to the create's first message.
// The released `@1.4` line keeps its shape, and a `@1.4` caller's message
// upgrades with the key absent, which the host reads as no sidecar.

const settings = {
  harnessId: "codex" as const,
  model: "gpt-5.4",
  permissionMode: "supervised" as const,
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "epic" as const,
  profileId: null,
  ultracode: false,
};
const initialMessageV14 = {
  messageId: "message-1",
  clientActionId: "action-1",
  content: { type: "doc", content: [] },
  sender: { type: "user" as const, userId: "user-1" },
  settings,
  accountContext: { type: "PERSONAL" as const },
  sentFromHostId: "host-2",
};
const annotation = {
  kind: "browser-annotation" as const,
  annotationId: "annotation-1",
  source: {
    kind: "canvas" as const,
    artifactId: "canvas-1",
    artifactTitle: "Checkout",
    boardPath: "boards/checkout.html",
    canvasPage: null,
  },
  capturedAt: 1,
  comment: "",
  counts: { elements: 1, regions: 0, strokes: 0 },
  elements: [],
  imageFileName: "crop.png",
  imageHash: "a".repeat(64),
  droppedElementCount: 0,
};
const createChatV14: CreateChatRequestV14 = {
  epicId: "epic-1",
  chatId: "chat-1",
  parentId: null,
  hostId: "host-1",
  title: "Chat",
  worktreeIntent: null,
  initialMessage: initialMessageV14,
};
const epicLight = {
  id: "epic-1",
  title: "Epic",
  initialUserPrompt: "Do the thing",
  ticketCount: 0,
  specCount: 0,
  storyCount: 0,
  reviewCount: 0,
  status: "in_progress",
  createdAt: 1000,
  updatedAt: 1000,
  createdBy: "user-1",
  version: "1",
};
const createEpicV14: CreateEpicRequestV14 = {
  epic: epicLight,
  repoIdentifiers: [],
  workspaces: [],
  chat: {
    chatId: "chat-1",
    parentId: null,
    hostId: "host-1",
    title: "Chat",
    worktreeIntent: null,
    initialMessage: initialMessageV14,
  },
};

describe("epic.createChat@1.5 and epic.create@1.5 carry the browser-annotation sidecar", () => {
  it("the released @1.4 initial message has no browserAnnotations key", () => {
    expect(createChatInitialMessageSchemaV14.shape).not.toHaveProperty(
      "browserAnnotations",
    );
    expect(epicCreateChatV14.schemaVersion).toEqual({ major: 1, minor: 4 });
    expect(epicCreateV14.schemaVersion).toEqual({ major: 1, minor: 4 });
  });

  it("parses a create-chat request whose first message carries a record", () => {
    const parsed = epicCreateChatV15.requestSchema.parse({
      ...createChatV14,
      initialMessage: {
        ...initialMessageV14,
        browserAnnotations: [annotation],
      },
    });
    expect(parsed.initialMessage?.browserAnnotations).toEqual([annotation]);
  });

  it("upgrades a @1.4 create-chat request with the sidecar absent", () => {
    const upgraded = epicCreateChatUpgradeV14ToV15.upgradeRequest(createChatV14);
    expect(upgraded.initialMessage).not.toHaveProperty("browserAnnotations");
    expect(upgraded.initialMessage?.sentFromHostId).toBe("host-2");
  });

  it("parses and upgrades the folded chat seed of epic.create the same way", () => {
    const parsed = epicCreateV15.requestSchema.parse({
      ...createEpicV14,
      chat: {
        ...createEpicV14.chat,
        initialMessage: {
          ...initialMessageV14,
          browserAnnotations: [annotation],
        },
      },
    });
    expect(parsed.chat?.initialMessage?.browserAnnotations).toEqual([
      annotation,
    ]);
    const upgraded = epicCreateUpgradeV14ToV15.upgradeRequest(createEpicV14);
    expect(upgraded.chat?.initialMessage).not.toHaveProperty(
      "browserAnnotations",
    );
  });

  it("strips the sidecar for a @1.4 peer's own request schema", () => {
    const stripped = epicCreateChatV14.requestSchema.parse({
      ...createChatV14,
      initialMessage: {
        ...initialMessageV14,
        browserAnnotations: [annotation],
      },
    });
    expect(stripped.initialMessage).not.toHaveProperty("browserAnnotations");
  });
});
