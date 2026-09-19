import { describe, expect, it } from "vitest";
import { isPostV1GuiHarnessId } from "@traycer/protocol/host/agent/post-v1-gui-harnesses";
import { PENDING_FALLBACK_STATE_VALUES } from "@traycer/protocol/host/agent/gui/subscribe";
import { PROVIDER_ID_VALUES } from "@traycer/protocol/host/provider-ids";
import { CHAT_EVENT_TYPES } from "@traycer/protocol/persistence/epic/chat-events";
import { KNOWN_CHAT_EVENT_TYPES } from "@traycer/protocol/persistence/chat-sync/entries";
import { PROVIDER_NOTICE_KINDS_PRE_HARNESS_MESSAGE } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  ALL_PERMISSION_MODES,
  ALL_PERMISSION_MODES_PRE_AUTO,
} from "@traycer/protocol/persistence/epic/foundation";

// Independent pins: the z.enum operands as they stood at OSS 4a00b08be,
// before the tuple rewrite. Copied from
// `git -C traycer show 4a00b08be:<file>`. Do not derive these from the
// live enum's `.options` — that list is built from the tuple under test.

describe("lazySchema literal tuples match the pre-rewrite enum lists", () => {
  it("ALL_PERMISSION_MODES", () => {
    expect(ALL_PERMISSION_MODES).toEqual([
      "supervised",
      "auto_accept_edits",
      "auto",
      "full_access",
    ]);
  });

  it("ALL_PERMISSION_MODES_PRE_AUTO", () => {
    // Frozen wire list: `permissionModeSchemaPreAuto` at 4a00b08be.
    expect(ALL_PERMISSION_MODES_PRE_AUTO).toEqual([
      "supervised",
      "auto_accept_edits",
      "full_access",
    ]);
  });

  it("CHAT_EVENT_TYPES and KNOWN_CHAT_EVENT_TYPES", () => {
    const chatEventTypesAtRewrite = [
      "send.accepted",
      "send.failed",
      "queue.added",
      "queue.edited",
      "queue.reordered",
      "queue.cancelled",
      "queue.steerRequested",
      "queue.steerAborted",
      "queue.paused",
      "queue.resumed",
      "queue.started",
      "queue.steered",
      "queue.fallback",
      "turn.started",
      "turn.completed",
      "turn.stopped",
      "turn.interrupted",
      "approval.requested",
      "approval.resolved",
      "approval.denied",
      "approval.abandoned",
      "interview.requested",
      "interview.resolved",
      "interview.errored",
      "checkpoint.captured",
      "checkpoint.restoreStarted",
      "checkpoint.restored",
      "permission.blocked",
      "harness.error",
      "history.deleted",
      "chat.forked",
      "chat.imported",
      "setup.creating",
      "setup.running",
      "setup.succeeded",
      "setup.failed",
      "setup.cancelled",
      "worktree.missing",
    ];
    expect(CHAT_EVENT_TYPES).toEqual(chatEventTypesAtRewrite);
    expect(KNOWN_CHAT_EVENT_TYPES).toEqual(chatEventTypesAtRewrite);
  });

  it("PROVIDER_ID_VALUES", () => {
    expect(PROVIDER_ID_VALUES).toEqual([
      "claude-code",
      "codex",
      "opencode",
      "cursor",
      "traycer",
      "grok",
      "qwen",
      "kiro",
      "droid",
      "kimi",
      "copilot",
      "kilocode",
      "openrouter",
      "amp",
      "devin",
      "pi",
      "hermes",
      "omp",
      "huggingface",
      "reasonix",
      "antigravity",
    ]);
  });

  it("PENDING_FALLBACK_STATE_VALUES", () => {
    expect(PENDING_FALLBACK_STATE_VALUES).toEqual([
      "retrying",
      "hold",
      "choosing",
      "switching",
      "waiting",
    ]);
  });

  it("PROVIDER_NOTICE_KINDS_PRE_HARNESS_MESSAGE", () => {
    // Frozen wire list: `providerNoticeKindSchemaPreHarnessMessage` at
    // 4a00b08be.
    expect(PROVIDER_NOTICE_KINDS_PRE_HARNESS_MESSAGE).toEqual([
      "model_rerouted",
      "model_verification",
      "safety_buffering",
    ]);
  });
});

describe("isPostV1GuiHarnessId", () => {
  it("is true for the post-v1 ids, false for the v1.0 freeze and null", () => {
    // Frozen v1.0 wire list: `guiHarnessIdSchemaV10` at 4a00b08be.
    const guiHarnessIdsV10 = [
      "claude",
      "codex",
      "opencode",
      "traycer",
      "cursor",
    ] as const;
    // Live `guiHarnessIdSchema` at 4a00b08be minus that freeze. Written out
    // rather than recomputed from live `.options`.
    const postV1GuiHarnessIds = [
      "grok",
      "qwen",
      "kiro",
      "droid",
      "kimi",
      "copilot",
      "kilocode",
      "openrouter",
      "amp",
      "devin",
      "pi",
      "hermes",
      "omp",
      "huggingface",
      "reasonix",
      "antigravity",
    ] as const;
    for (const harnessId of postV1GuiHarnessIds) {
      expect(isPostV1GuiHarnessId(harnessId)).toBe(true);
    }
    for (const harnessId of guiHarnessIdsV10) {
      expect(isPostV1GuiHarnessId(harnessId)).toBe(false);
    }
    expect(isPostV1GuiHarnessId(null)).toBe(false);
  });
});
