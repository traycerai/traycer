import { describe, expect, it } from "vitest";
import { tuiHarnessIdSchema } from "@traycer/protocol/persistence/epic/foundation";
import { tuiAgentSchema } from "@traycer/protocol/persistence/epic/tui-agents";

describe("persisted TUI agent schema compatibility", () => {
  it("retains the released Cursor discriminator and record variant", () => {
    expect(tuiHarnessIdSchema.safeParse("cursor").success).toBe(true);
    expect(
      tuiAgentSchema.safeParse({
        id: "cursor-agent-1",
        parentId: null,
        title: "",
        isTitleEditedByUser: false,
        createdAt: 1,
        updatedAt: 1,
        hostId: "host-1",
        userId: "user-1",
        workspaceFolders: ["/repo"],
        model: null,
        reasoningEffort: null,
        agentMode: "epic",
        terminalAgentArgs: null,
        terminalShellCommand: null,
        terminalShellArgs: null,
        profileId: null,
        harnessId: "cursor",
        harnessSessionId: null,
      }).success,
    ).toBe(true);
  });
});
