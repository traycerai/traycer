import { describe, expect, it } from "vitest";
import {
  chatSubscribeV10,
  chatSubscribeV11,
  chatSubscribeV12,
  chatSubscribeV13,
  chatSubscribeV14,
  chatSubscribeV15,
  chatSubscribeV16,
  chatSubscribeV17,
  chatSubscribeV18,
  chatSubscribeV19,
  chatSubscribeV110,
  chatSubscribeV111,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  sessionImportRunV10,
  sessionImportRunV11,
  sessionImportRunV12,
} from "@traycer/protocol/host/session-import/run";
import {
  permissionModeSchema,
  permissionModeSchemaPreAuto,
} from "@traycer/protocol/persistence/epic/foundation";

// The `auto` permission mode is whichever member `permissionModeSchema` has
// that `permissionModeSchemaPreAuto` does not - derived rather than restated,
// so a future rename of the mode still finds it here.
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

// A mode every pre-auto AND live line agrees on, used to prove each fixture is
// otherwise well-formed before the `auto` assertion runs - so a rejection
// caused by a malformed fixture is never mistaken for the guard under test.
const PRE_AUTO_SAMPLE_MODE = "auto_accept_edits";
if (!PRE_AUTO_MODE_SET.has(PRE_AUTO_SAMPLE_MODE)) {
  throw new Error(
    `${PRE_AUTO_SAMPLE_MODE} is no longer a member of permissionModeSchemaPreAuto`,
  );
}

function ownerActionFields(clientActionId: string): {
  hasBinaryPayload: false;
  epicId: string;
  chatId: string;
  clientActionId: string;
} {
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

function sendFrame(permissionMode: string): Record<string, unknown> {
  return {
    kind: "send",
    ...ownerActionFields("action-send"),
    messageId: "message-1",
    content: { type: "doc", content: [] },
    sender: { type: "user", userId: "user-1" },
    settings: runSettings(permissionMode),
    accountContext: { type: "PERSONAL" },
  };
}

function editUserMessageFrame(permissionMode: string): Record<string, unknown> {
  return {
    kind: "editUserMessage",
    ...ownerActionFields("action-edit"),
    targetMessageId: "message-1",
    messageId: "message-2",
    content: { type: "doc", content: [] },
    sender: { type: "user", userId: "user-1" },
    settings: runSettings(permissionMode),
    accountContext: { type: "PERSONAL" },
    revertFileChanges: false,
  };
}

function queueSteerNowFrame(permissionMode: string): Record<string, unknown> {
  return {
    kind: "queueSteerNow",
    ...ownerActionFields("action-steer"),
    queueItemId: "queue-1",
    newSettings: runSettings(permissionMode),
  };
}

function queueSettingsUpdateFrame(
  permissionMode: string,
): Record<string, unknown> {
  return {
    kind: "queueSettingsUpdate",
    ...ownerActionFields("action-queue-settings-update"),
    queueItemId: "queue-1",
    settings: runSettings(permissionMode),
    accountContext: { type: "PERSONAL" },
  };
}

function queueSettingsRestampFrame(
  permissionMode: string,
): Record<string, unknown> {
  return {
    kind: "queueSettingsRestamp",
    ...ownerActionFields("action-queue-settings-restamp"),
    settings: runSettings(permissionMode),
    accountContext: { type: "PERSONAL" },
    excludeQueueItemId: null,
  };
}

function activePermissionModeUpdateFrame(
  permissionMode: string,
): Record<string, unknown> {
  return {
    kind: "activePermissionModeUpdate",
    ...ownerActionFields("action-mode-update"),
    permissionMode,
  };
}

// Every `chat.subscribe` client-frame kind that carries a permission mode,
// either through a `chatRunSettings` tuple or (for `activePermissionModeUpdate`)
// directly. `build` produces a frame that is otherwise valid on every line
// below - only the `permissionMode` value is the axis under test.
const MODE_BEARING_FRAME_KINDS = [
  { kind: "send", build: sendFrame },
  { kind: "editUserMessage", build: editUserMessageFrame },
  { kind: "queueSteerNow", build: queueSteerNowFrame },
  { kind: "queueSettingsUpdate", build: queueSettingsUpdateFrame },
  { kind: "queueSettingsRestamp", build: queueSettingsRestampFrame },
  {
    kind: "activePermissionModeUpdate",
    build: activePermissionModeUpdateFrame,
  },
] as const;

const CHAT_SUBSCRIBE_LINES = [
  { label: "1.0", contract: chatSubscribeV10 },
  { label: "1.1", contract: chatSubscribeV11 },
  { label: "1.2", contract: chatSubscribeV12 },
  { label: "1.3", contract: chatSubscribeV13 },
  { label: "1.4", contract: chatSubscribeV14 },
  { label: "1.5", contract: chatSubscribeV15 },
  { label: "1.6", contract: chatSubscribeV16 },
  { label: "1.7", contract: chatSubscribeV17 },
  { label: "1.8", contract: chatSubscribeV18 },
  { label: "1.9", contract: chatSubscribeV19 },
  { label: "1.10", contract: chatSubscribeV110 },
  { label: "1.11", contract: chatSubscribeV111 },
] as const;

// The boundary is read off the live line's own version, never restated as a
// literal `11` - that minor has already been renumbered once (see
// `chatSubscribeV111`'s doc comment).
const CHAT_SUBSCRIBE_AUTO_MINOR = chatSubscribeV111.schemaVersion.minor;

describe("chat.subscribe: the auto permission mode is pinned below 1.11, everywhere it can ride", () => {
  for (const line of CHAT_SUBSCRIBE_LINES) {
    const acceptsAuto =
      line.contract.schemaVersion.minor === CHAT_SUBSCRIBE_AUTO_MINOR;

    describe(`chat.subscribe@${line.label}`, () => {
      for (const frameKind of MODE_BEARING_FRAME_KINDS) {
        describe(frameKind.kind, () => {
          it(`accepts a well-formed frame with permissionMode: "${PRE_AUTO_SAMPLE_MODE}"`, () => {
            const result = line.contract.clientFrameSchema.safeParse(
              frameKind.build(PRE_AUTO_SAMPLE_MODE),
            );

            expect(result.success).toBe(true);
          });

          it(
            acceptsAuto
              ? `accepts permissionMode: "${AUTO_MODE}"`
              : `rejects permissionMode: "${AUTO_MODE}"`,
            () => {
              const result = line.contract.clientFrameSchema.safeParse(
                frameKind.build(AUTO_MODE),
              );

              expect(result.success).toBe(acceptsAuto);

              if (!acceptsAuto && !result.success) {
                const touchesPermissionMode = result.error.issues.some(
                  (issue) => issue.path.includes("permissionMode"),
                );
                expect(touchesPermissionMode).toBe(true);
              }
            },
          );
        });
      }
    });
  }
});

const SESSION_IMPORT_RUN_LINES = [
  { label: "1.0", contract: sessionImportRunV10 },
  { label: "1.1", contract: sessionImportRunV11 },
  { label: "1.2", contract: sessionImportRunV12 },
] as const;

const SESSION_IMPORT_RUN_AUTO_MINOR = sessionImportRunV12.schemaVersion.minor;

function sessionImportOpenRequest(
  permissionMode: string,
): Record<string, unknown> {
  return { selections: [], permissionMode };
}

describe("sessionImport.run: the auto permission mode is pinned below 1.2", () => {
  for (const line of SESSION_IMPORT_RUN_LINES) {
    const acceptsAuto =
      line.contract.schemaVersion.minor === SESSION_IMPORT_RUN_AUTO_MINOR;

    describe(`sessionImport.run@${line.label}`, () => {
      it(`accepts a well-formed open request with permissionMode: "${PRE_AUTO_SAMPLE_MODE}"`, () => {
        const result = line.contract.openRequestSchema.safeParse(
          sessionImportOpenRequest(PRE_AUTO_SAMPLE_MODE),
        );

        expect(result.success).toBe(true);
      });

      it(
        acceptsAuto
          ? `accepts permissionMode: "${AUTO_MODE}"`
          : `rejects permissionMode: "${AUTO_MODE}"`,
        () => {
          const result = line.contract.openRequestSchema.safeParse(
            sessionImportOpenRequest(AUTO_MODE),
          );

          expect(result.success).toBe(acceptsAuto);

          if (!acceptsAuto && !result.success) {
            const touchesPermissionMode = result.error.issues.some((issue) =>
              issue.path.includes("permissionMode"),
            );
            expect(touchesPermissionMode).toBe(true);
          }
        },
      );
    });
  }
});

// ─── Position guard: the live-rebuilt middle segment cannot have moved ─────
//
// `subscribe.ts` destructures the shared pre-`1.11` middle client-frame
// segment by POSITION into named consts, then rebuilds a live copy of it
// (`chatSubscribeClientFrameSchemaMiddleOptionsLive`) with exactly the four
// mode-bearing frames re-bound to the live enum.
//
// **What catches a mis-counted position is the block above, not this one.** An
// off-by-one destructure re-lists the same handles in the same order, so the
// ordered `kind` list is UNCHANGED by it - what moves is which frame received
// the widening, and `1.11` then rejects `auto` on the frame that should have
// got it. Verified by mutation: dropping the `.extend(...)` off the live
// `queueSteerNow` entry turns exactly one test red, `1.11`'s `queueSteerNow >
// accepts permissionMode: "auto"`.
//
// This block covers the other half - a frame DROPPED, DUPLICATED or REORDERED
// by the rebuild, which the by-`kind` assertions above cannot see because they
// only ever address the frames that are still there.
describe("chat.subscribe client-frame position guard for the auto widen", () => {
  it("1.11's client frame admits the exact same ordered kind list as 1.10's", () => {
    const v111Kinds = chatSubscribeV111.clientFrameSchema.options.map(
      (option) => option.shape.kind.value,
    );
    const v110Kinds = chatSubscribeV110.clientFrameSchema.options.map(
      (option) => option.shape.kind.value,
    );

    expect(v111Kinds).toEqual(v110Kinds);
  });

  it("1.9's client frame is 1.10's minus exactly the two grace-hold actions, same relative order", () => {
    const v19Kinds = chatSubscribeV19.clientFrameSchema.options.map(
      (option) => option.shape.kind.value,
    );
    const v110Kinds = chatSubscribeV110.clientFrameSchema.options.map(
      (option) => option.shape.kind.value,
    );
    const graceHoldKinds = ["fallback.holdForChoice", "fallback.releaseChoice"];

    expect(v110Kinds.filter((kind) => !graceHoldKinds.includes(kind))).toEqual(
      v19Kinds,
    );
    expect(v110Kinds.filter((kind) => graceHoldKinds.includes(kind))).toEqual(
      graceHoldKinds,
    );
  });
});
