import { describe, expect, it } from "vitest";
import { tuiAgentSchema } from "@traycer/protocol/persistence/epic/tui-agents";

/**
 * `archivedAt` back-compat guard on `baseTuiAgentFields`, shared by all four
 * terminal-agent variants. Same host-backed archive flag as
 * `chatSchema.archivedAt` (a single `epic.setChatArchived` RPC covers both
 * chats and TUI agents by id) - records persisted before archiving existed
 * must still parse, defaulting to not-archived.
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

describe("tuiAgentSchema.archivedAt (claude variant)", () => {
  it("defaults to null when absent", () => {
    const parsed = tuiAgentSchema.safeParse({
      harnessId: "claude",
      ...baseFields(),
      harnessSessionId: "session-1",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.archivedAt).toBeNull();
    }
  });

  it("round-trips a set archivedAt", () => {
    const parsed = tuiAgentSchema.safeParse({
      harnessId: "claude",
      ...baseFields(),
      harnessSessionId: "session-1",
      archivedAt: 999,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.archivedAt).toBe(999);
    }
  });
});

describe("tuiAgentSchema.archivedAt (codex variant, nullable harnessSessionId)", () => {
  it("defaults to null when absent", () => {
    const parsed = tuiAgentSchema.safeParse({
      harnessId: "codex",
      ...baseFields(),
      harnessSessionId: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.archivedAt).toBeNull();
    }
  });

  it("round-trips a set archivedAt", () => {
    const parsed = tuiAgentSchema.safeParse({
      harnessId: "codex",
      ...baseFields(),
      harnessSessionId: null,
      archivedAt: 555,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.archivedAt).toBe(555);
    }
  });
});
