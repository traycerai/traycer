import { describe, expect, it } from "vitest";
import { tuiAgentSchema } from "@traycer/protocol/persistence/epic/tui-agents";

/**
 * `pendingForkSourceHarnessSessionId` back-compat guard on
 * `baseTuiAgentFields`, shared by all TUI agent variants. Records persisted
 * before durable native-fork provenance existed must still parse, defaulting
 * to null (no pending fork). When set, the field round-trips so a pre-launch
 * A2A fork's source session id survives across hosts/releases.
 */

function baseFields() {
  return {
    id: "tui-1",
    parentId: null,
    title: "",
    isTitleEditedByUser: false,
    createdAt: 1,
    updatedAt: 2,
    hostId: "host-1",
    userId: "user-1",
    workspaceFolders: ["/repo"],
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
    profileId: null,
  };
}

describe("tuiAgentSchema.pendingForkSourceHarnessSessionId (claude variant)", () => {
  it("defaults to null when absent", () => {
    const parsed = tuiAgentSchema.safeParse({
      harnessId: "claude",
      ...baseFields(),
      harnessSessionId: "session-1",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.pendingForkSourceHarnessSessionId).toBeNull();
    }
  });

  it("round-trips a set pendingForkSourceHarnessSessionId", () => {
    const parsed = tuiAgentSchema.safeParse({
      harnessId: "claude",
      ...baseFields(),
      harnessSessionId: "session-dest",
      pendingForkSourceHarnessSessionId: "session-source",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.pendingForkSourceHarnessSessionId).toBe(
        "session-source",
      );
    }
  });
});

describe("tuiAgentSchema.pendingForkSourceHarnessSessionId (codex variant, nullable harnessSessionId)", () => {
  it("defaults to null when absent", () => {
    const parsed = tuiAgentSchema.safeParse({
      harnessId: "codex",
      ...baseFields(),
      harnessSessionId: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.pendingForkSourceHarnessSessionId).toBeNull();
    }
  });

  it("round-trips a set pendingForkSourceHarnessSessionId", () => {
    const parsed = tuiAgentSchema.safeParse({
      harnessId: "codex",
      ...baseFields(),
      harnessSessionId: null,
      pendingForkSourceHarnessSessionId: "codex-source-thread",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.pendingForkSourceHarnessSessionId).toBe(
        "codex-source-thread",
      );
    }
  });
});
