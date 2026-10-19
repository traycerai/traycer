import { describe, expect, it } from "vitest";
import { listAgentsResponseSchema } from "@traycer/protocol/host/agent/shared";

// traycer#2357 item 1a, CLI half: `traycer agent configure` takes the whole
// tuple (`--profile` is required, an omitted `--permission-mode` becomes
// `full_access`), and `traycer --json agent list` reads its rows through this
// schema. Before `agent.list@10.1` the schema had no key for either and
// stripped both, so a script could not restate them.

const AGENT_ROW = {
  id: "agent-1",
  parentId: null,
  hostId: "host-1",
  isLocal: true,
  surface: "gui" as const,
  harnessId: "codex" as const,
  title: "Existing chat",
  isSelf: false,
  capabilities: { readTranscript: true, sendMessage: true },
  active: false,
  folderPaths: ["/repo"],
  isWorktree: true,
  runConfig: null,
  sessionState: null,
  lastExit: null,
  archived: true,
  profile: "ambient",
  permissionMode: "supervised",
};

describe("agent.list row: the run tuple a configure must restate", () => {
  it("carries the agent's profile and permission mode", () => {
    const parsed = listAgentsResponseSchema.parse({
      caller: { agentId: "agent-0", canSendMessages: true },
      scope: "user",
      agents: [AGENT_ROW],
    });
    expect(parsed.agents[0]).toMatchObject({
      profile: "ambient",
      permissionMode: "supervised",
    });
  });
});
