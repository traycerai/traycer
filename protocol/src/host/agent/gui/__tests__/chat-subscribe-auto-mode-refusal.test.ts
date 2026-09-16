import { describe, expect, it } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  chatSubscribeClientFrameSchema,
  type ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  permissionModeSchema,
  permissionModeSchemaPreAuto,
} from "@traycer/protocol/persistence/epic/foundation";
import {
  projectChatClientFrameForVersion,
  supportsAutoPermissionMode,
} from "../chat-frame-compat";

// Derived rather than restated as the literal "auto" - the same derivation
// `chat-subscribe-auto-mode-lines.test.ts` uses, so a rename of the mode is
// caught here too rather than leaving a string that silently matches nothing.
const PRE_AUTO_MODE_SET = new Set<string>(permissionModeSchemaPreAuto.options);
const WIDENED_MODES = permissionModeSchema.options.filter(
  (mode) => !PRE_AUTO_MODE_SET.has(mode),
);
if (WIDENED_MODES.length !== 1) {
  throw new Error(
    `expected exactly one mode widened past permissionModeSchemaPreAuto, found ${JSON.stringify(WIDENED_MODES)}`,
  );
}
const AUTO_MODE = WIDENED_MODES[0];
if (AUTO_MODE === undefined) throw new Error("unreachable");

const PRE_AUTO_SAMPLE_MODE = "auto_accept_edits";
if (!PRE_AUTO_MODE_SET.has(PRE_AUTO_SAMPLE_MODE)) {
  throw new Error(
    `${PRE_AUTO_SAMPLE_MODE} is no longer a member of permissionModeSchemaPreAuto`,
  );
}

function ownerActionFields(clientActionId: string): Record<string, unknown> {
  return {
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    clientActionId,
  };
}

function runSettings(permissionMode: string): Record<string, unknown> {
  return {
    harnessId: "codex",
    model: "gpt-5-codex",
    permissionMode,
    reasoningEffort: null,
    agentMode: "epic",
  };
}

function parseLiveClientFrame(
  raw: Record<string, unknown>,
): ChatSubscribeClientFrame {
  return chatSubscribeClientFrameSchema.parse(raw);
}

// The six client-frame kinds `subscribe.ts` re-binds to the live permission
// mode enum on `1.12` (see `chatSubscribeClientFrameSchemaMiddleOptionsLive`
// and the two `.extend({ settings: chatRunSettingsSchema })` spots at the top
// of `chatSubscribeClientFrameSchemaOptions`): `send` and `editUserMessage`
// through their `settings` tuple, `queueSteerNow` through the nullable
// `newSettings`, `queueSettingsUpdate` / `queueSettingsRestamp` through
// `settings`, and `activePermissionModeUpdate` through a bare
// `permissionMode`. Confirmed by reading `subscribe.ts` directly rather than
// walking the union here, since every mode-bearing frame is exactly one of
// these six and no seventh exists on the live schema.
const MODE_BEARING_FRAME_KINDS: ReadonlyArray<{
  readonly kind: string;
  readonly build: (permissionMode: string) => Record<string, unknown>;
}> = [
  {
    kind: "send",
    build: (permissionMode) => ({
      kind: "send",
      ...ownerActionFields("action-send"),
      messageId: "message-1",
      content: { type: "doc", content: [] },
      sender: { type: "user", userId: "user-1" },
      settings: runSettings(permissionMode),
      accountContext: { type: "PERSONAL" },
    }),
  },
  {
    kind: "editUserMessage",
    build: (permissionMode) => ({
      kind: "editUserMessage",
      ...ownerActionFields("action-edit"),
      targetMessageId: "message-1",
      messageId: "message-2",
      content: { type: "doc", content: [] },
      sender: { type: "user", userId: "user-1" },
      settings: runSettings(permissionMode),
      accountContext: { type: "PERSONAL" },
      revertFileChanges: false,
    }),
  },
  {
    kind: "queueSteerNow",
    build: (permissionMode) => ({
      kind: "queueSteerNow",
      ...ownerActionFields("action-steer"),
      queueItemId: "queue-1",
      newSettings: runSettings(permissionMode),
    }),
  },
  {
    kind: "queueSettingsUpdate",
    build: (permissionMode) => ({
      kind: "queueSettingsUpdate",
      ...ownerActionFields("action-queue-settings-update"),
      queueItemId: "queue-1",
      settings: runSettings(permissionMode),
      accountContext: { type: "PERSONAL" },
    }),
  },
  {
    kind: "queueSettingsRestamp",
    build: (permissionMode) => ({
      kind: "queueSettingsRestamp",
      ...ownerActionFields("action-queue-settings-restamp"),
      settings: runSettings(permissionMode),
      accountContext: { type: "PERSONAL" },
      excludeQueueItemId: null,
    }),
  },
  {
    kind: "activePermissionModeUpdate",
    build: (permissionMode) => ({
      kind: "activePermissionModeUpdate",
      ...ownerActionFields("action-mode-update"),
      permissionMode,
    }),
  },
];

const V110: SchemaVersion = { major: 1, minor: 10 };
// `1.11` is main's shell-host tier, which the merge to main slotted BELOW the
// auto line. It is pre-`auto` like `1.10`, so it belongs on the refusing side
// of the cliff - a line can gain a server surface and keep an older client
// enum, and this is the case that proves the two freezes are separate.
const V111: SchemaVersion = { major: 1, minor: 11 };
const V112: SchemaVersion = { major: 1, minor: 12 };

describe("projectChatClientFrameForVersion: the auto cliff at chat.subscribe@1.12", () => {
  for (const frameKind of MODE_BEARING_FRAME_KINDS) {
    it(`refuses ${frameKind.kind} carrying "${AUTO_MODE}" on 1.10`, () => {
      const frame = parseLiveClientFrame(frameKind.build(AUTO_MODE));

      expect(() => projectChatClientFrameForVersion(frame, V110)).toThrow(
        'permissionMode "auto" requires chat.subscribe@1.12 or newer',
      );
    });

    it(`leaves ${frameKind.kind} carrying "${PRE_AUTO_SAMPLE_MODE}" unaffected on 1.10`, () => {
      const frame = parseLiveClientFrame(frameKind.build(PRE_AUTO_SAMPLE_MODE));

      expect(projectChatClientFrameForVersion(frame, V110)).toBe(frame);
    });

    it(`refuses ${frameKind.kind} carrying "${AUTO_MODE}" on 1.11 - the shell-host tier is still pre-auto`, () => {
      const frame = parseLiveClientFrame(frameKind.build(AUTO_MODE));

      expect(() => projectChatClientFrameForVersion(frame, V111)).toThrow(
        'permissionMode "auto" requires chat.subscribe@1.12 or newer',
      );
    });

    it(`passes ${frameKind.kind} carrying "${AUTO_MODE}" through unchanged on 1.12`, () => {
      const frame = parseLiveClientFrame(frameKind.build(AUTO_MODE));

      expect(projectChatClientFrameForVersion(frame, V112)).toBe(frame);
    });

    it(`refuses ${frameKind.kind} carrying "${AUTO_MODE}" when the handshake has not resolved (null)`, () => {
      const frame = parseLiveClientFrame(frameKind.build(AUTO_MODE));

      expect(() => projectChatClientFrameForVersion(frame, null)).toThrow(
        'permissionMode "auto" requires chat.subscribe@1.12 or newer',
      );
    });
  }

  it('does not throw for queueSteerNow with newSettings: null on 1.10 - the guard reads a mode, not "any settings"', () => {
    const frame = parseLiveClientFrame({
      kind: "queueSteerNow",
      ...ownerActionFields("action-steer-null"),
      queueItemId: "queue-1",
      newSettings: null,
    });

    expect(projectChatClientFrameForVersion(frame, V110)).toBe(frame);
  });
});

describe("supportsAutoPermissionMode", () => {
  it("is false below 1.12, the shell-host tier at 1.11 included", () => {
    expect(supportsAutoPermissionMode({ major: 1, minor: 11 })).toBe(false);
    expect(supportsAutoPermissionMode({ major: 1, minor: 10 })).toBe(false);
    expect(supportsAutoPermissionMode({ major: 1, minor: 0 })).toBe(false);
  });

  it("is true at and above 1.12", () => {
    expect(supportsAutoPermissionMode({ major: 1, minor: 12 })).toBe(true);
    expect(supportsAutoPermissionMode({ major: 1, minor: 13 })).toBe(true);
  });

  it("is false when the handshake has not resolved (null)", () => {
    expect(supportsAutoPermissionMode(null)).toBe(false);
  });
});
