import { describe, expect, it } from "vitest";
import {
  grokUserMessageAnchorResolvedSchema,
  runtimeEventSchemaPreFallback,
  runtimeEventSchemaPreImage,
} from "@traycer/protocol/host/agent/gui/agent-runtime";
import {
  chatSessionAnchorSchemaPreAntigravity,
  chatSessionAnchorSchemaPreReasonix,
  grokChatSessionAnchorSchema,
  grokChatSessionAnchorSchemaPrePromptIndex,
} from "../senders";

// The `**.grokPromptIndex` entries in `compat-exceptions.json` tolerate the
// field on the released `chat.subscribe@1.7`/`@1.8` lines on two grounds:
// a payload written before the field parses to null, and the frozen
// pre-index copies never carry it. Both are pinned here, so the exception
// cannot outlive the tolerance it rests on.

// A pre-field payload has no key at all, which is how a persisted anchor or
// a released peer's frame round-trips through JSON.
const legacyGrokAnchor = {
  harnessId: "grok" as const,
  hostId: "host-1",
  sessionId: "session-1",
  sessionWorkspaceSnapshot: {
    workspaceKind: "session-snapshot" as const,
    primaryWorkspace: "/repo",
    secondaryWorkspaces: [],
  },
  createdAt: 100,
};

const legacyAnchorResolved = {
  harnessId: "grok" as const,
  sessionId: "session-1",
  grokSessionId: null,
};

function anchorResolvedEvent(anchor: Record<string, unknown>) {
  return {
    blockId: "block-1",
    timestamp: 100,
    type: "user_message.anchor_resolved" as const,
    messageId: "message-1",
    anchor,
  };
}

describe("grokPromptIndex tolerance on the live schemas", () => {
  it("parses a session anchor written before the field with grokPromptIndex null", () => {
    const parsed = grokChatSessionAnchorSchema.parse(legacyGrokAnchor);
    expect(parsed.grokPromptIndex).toBeNull();
  });

  it("parses an anchor_resolved event written before the field with grokPromptIndex null", () => {
    const parsed =
      grokUserMessageAnchorResolvedSchema.parse(legacyAnchorResolved);
    expect(parsed.grokPromptIndex).toBeNull();
  });

  it("parses a 1.7/1.8 blockDelta anchor_resolved without the field to null", () => {
    // `runtimeEventSchemaPreFallback` is the union those two released lines
    // ship; it reaches the live grok arm by reference, which is the exact
    // path the exception entries name.
    const parsed = runtimeEventSchemaPreFallback.parse(
      anchorResolvedEvent(legacyAnchorResolved),
    );
    if (parsed.type !== "user_message.anchor_resolved") {
      throw new Error(`unexpected event type ${parsed.type}`);
    }
    if (parsed.anchor.harnessId !== "grok") {
      throw new Error(`unexpected harness ${parsed.anchor.harnessId}`);
    }
    expect(parsed.anchor.grokPromptIndex).toBeNull();
  });
});

describe("grokPromptIndex never reaches the frozen pre-index copies", () => {
  const anchorWithIndex = { ...legacyGrokAnchor, grokPromptIndex: 3 };

  it("is stripped by the frozen grok anchor copy", () => {
    const parsed =
      grokChatSessionAnchorSchemaPrePromptIndex.parse(anchorWithIndex);
    expect(parsed).not.toHaveProperty("grokPromptIndex");
  });

  it("is stripped by the frozen anchor unions bound to the released lines", () => {
    for (const union of [
      chatSessionAnchorSchemaPreReasonix,
      chatSessionAnchorSchemaPreAntigravity,
    ]) {
      const parsed = union.parse(anchorWithIndex);
      expect(parsed).not.toHaveProperty("grokPromptIndex");
    }
  });

  it("is stripped by the 1.0–1.6 blockDelta anchor_resolved arm", () => {
    const parsed = runtimeEventSchemaPreImage.parse(
      anchorResolvedEvent({ ...legacyAnchorResolved, grokPromptIndex: 3 }),
    );
    if (parsed.type !== "user_message.anchor_resolved") {
      throw new Error(`unexpected event type ${parsed.type}`);
    }
    expect(parsed.anchor).not.toHaveProperty("grokPromptIndex");
  });
});
