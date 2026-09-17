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
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
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
// mode enum on the auto line (see `chatSubscribeClientFrameSchemaMiddleOptionsLive`
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

// DERIVED, never restated. The auto line has been renumbered four times - to
// `1.10`, `1.11`, `1.12` and now `1.13`, each time because main took the minor
// first - and every one of those moves broke a file that had written the
// number down. `latestMinor` cannot be redirected by a rename or a re-mint.
const AUTO_MINOR = hostStreamRpcRegistry["chat.subscribe"][1].latestMinor;
const AUTO_LINE: SchemaVersion = { major: 1, minor: AUTO_MINOR };

// The two tiers immediately below the cliff, expressed as offsets so they move
// with it. `AUTO_MINOR - 1` is main's draft-image line (it gained a server
// surface and kept the older client enum) and `- 2` is the shell-host line.
// Both are pre-`auto`, which is the case that proves those freezes are
// separate axes from this one.
const BELOW_AUTO: SchemaVersion = { major: 1, minor: AUTO_MINOR - 1 };
const TWO_BELOW_AUTO: SchemaVersion = { major: 1, minor: AUTO_MINOR - 2 };

describe("projectChatClientFrameForVersion: the auto cliff at the live chat.subscribe line", () => {
  for (const frameKind of MODE_BEARING_FRAME_KINDS) {
    it(`refuses ${frameKind.kind} carrying "${AUTO_MODE}" two minors below the auto line`, () => {
      const frame = parseLiveClientFrame(frameKind.build(AUTO_MODE));

      expect(() =>
        projectChatClientFrameForVersion(frame, TWO_BELOW_AUTO),
      ).toThrow(
        `permissionMode "auto" requires chat.subscribe@1.${AUTO_MINOR} or newer`,
      );
    });

    it(`leaves ${frameKind.kind} carrying "${PRE_AUTO_SAMPLE_MODE}" unaffected two minors below the auto line`, () => {
      const frame = parseLiveClientFrame(frameKind.build(PRE_AUTO_SAMPLE_MODE));

      expect(projectChatClientFrameForVersion(frame, TWO_BELOW_AUTO)).toBe(
        frame,
      );
    });

    it(`refuses ${frameKind.kind} carrying "${AUTO_MODE}" one minor below the auto line - still pre-auto`, () => {
      const frame = parseLiveClientFrame(frameKind.build(AUTO_MODE));

      expect(() => projectChatClientFrameForVersion(frame, BELOW_AUTO)).toThrow(
        `permissionMode "auto" requires chat.subscribe@1.${AUTO_MINOR} or newer`,
      );
    });

    it(`passes ${frameKind.kind} carrying "${AUTO_MODE}" through unchanged on the auto line`, () => {
      const frame = parseLiveClientFrame(frameKind.build(AUTO_MODE));

      expect(projectChatClientFrameForVersion(frame, AUTO_LINE)).toBe(frame);
    });

    it(`refuses ${frameKind.kind} carrying "${AUTO_MODE}" when the handshake has not resolved (null)`, () => {
      const frame = parseLiveClientFrame(frameKind.build(AUTO_MODE));

      expect(() => projectChatClientFrameForVersion(frame, null)).toThrow(
        `permissionMode "auto" requires chat.subscribe@1.${AUTO_MINOR} or newer`,
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

    expect(projectChatClientFrameForVersion(frame, TWO_BELOW_AUTO)).toBe(frame);
  });
});

describe("supportsAutoPermissionMode", () => {
  // Derived, because these literals were `11`/`10` when the auto line was
  // `1.12` and stayed compiling and passing when it moved to `1.13` - at which
  // point they tested two tiers that are no longer the adjacent ones and
  // stopped covering `1.12`, the line that had just inherited the pre-auto
  // union. An adjacent-tier assertion has to move with the tier.
  it("is false below the auto line, the two tiers beneath it included", () => {
    expect(
      supportsAutoPermissionMode({ major: 1, minor: AUTO_MINOR - 1 }),
    ).toBe(false);
    expect(
      supportsAutoPermissionMode({ major: 1, minor: AUTO_MINOR - 2 }),
    ).toBe(false);
    expect(supportsAutoPermissionMode({ major: 1, minor: 0 })).toBe(false);
  });

  it("is true at and above the auto line", () => {
    expect(supportsAutoPermissionMode({ major: 1, minor: AUTO_MINOR })).toBe(
      true,
    );
    // `AUTO_MINOR + 1`, not a literal equal to `AUTO_MINOR`: this arm is the
    // only one asserting ABOVE, and a literal that happens to match the line
    // makes it a duplicate of the arm above while reading as coverage.
    expect(
      supportsAutoPermissionMode({ major: 1, minor: AUTO_MINOR + 1 }),
    ).toBe(true);
  });

  it("is false when the handshake has not resolved (null)", () => {
    expect(supportsAutoPermissionMode(null)).toBe(false);
  });
});
