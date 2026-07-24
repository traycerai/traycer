import { describe, expect, it } from "vitest";
import { tuiHarnessIdSchema } from "@traycer/protocol/persistence/epic/foundation";
import { tuiAgentSchema } from "@traycer/protocol/persistence/epic/tui-agents";

/**
 * Cursor terminal-agent read-compatibility guard.
 *
 * Cursor is GUI-only in the product today - the host adapter no longer
 * implements the TUI surface, the runtime catalog omits it, and
 * `epic.createTuiAgent` rejects `harnessId: "cursor"`. But "cursor" stays a
 * RESERVED `TuiHarnessId` on the released persistence (and wire) schemas for
 * read compatibility: any epic that was written while the dormant path still
 * persisted Cursor terminal-agent records must keep reading. Removing the
 * schema value would be a destructive break of that persisted data.
 *
 * This freezes the compatibility boundary: the reserved id parses, and a whole
 * persisted Cursor `tuiAgents` record still round-trips to the discriminated
 * cursor variant.
 */
describe("cursor is a reserved TuiHarnessId (read compatibility)", () => {
  it("parses the reserved 'cursor' harness id", () => {
    expect(tuiHarnessIdSchema.safeParse("cursor").success).toBe(true);
  });

  it("parses a persisted Cursor terminal-agent record to the cursor variant", () => {
    const record = {
      harnessId: "cursor",
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
      // Cursor's chat id is nullable (mint could have failed), mirroring Codex.
      harnessSessionId: "chat-123",
    };

    const parsed = tuiAgentSchema.safeParse(record);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.harnessId).toBe("cursor");
    }
  });

  it("keeps a null Cursor harnessSessionId (no chat minted yet)", () => {
    const record = {
      harnessId: "cursor",
      id: "tui-2",
      parentId: null,
      title: "",
      isTitleEditedByUser: false,
      createdAt: 1,
      updatedAt: 2,
      hostId: "host-1",
      userId: "user-1",
      workspaceFolders: [],
      model: null,
      reasoningEffort: null,
      agentMode: "regular",
      terminalAgentArgs: null,
      terminalShellCommand: null,
      terminalShellArgs: null,
      profileId: null,
      harnessSessionId: null,
    };

    const parsed = tuiAgentSchema.safeParse(record);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.harnessId === "cursor") {
      expect(parsed.data.harnessSessionId).toBeNull();
    }
  });
});
