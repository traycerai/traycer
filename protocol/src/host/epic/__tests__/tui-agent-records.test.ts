import { describe, expect, it } from "vitest";
import {
  epicListTuiAgentsUpgradeV10ToV11,
  listTuiAgentsRequestV11Schema,
  listTuiAgentsResponseV11Schema,
} from "@traycer/protocol/host/epic/tui-agent-records";
import { hostRpcRegistry } from "@traycer/protocol/host/index";

describe("epic.listTuiAgents v1.0 -> v1.1 upgrade path", () => {
  it("fills hasDocReplica: true on an upgraded v1.0 request", () => {
    // A `@1.0` caller predates `epic.subscribe@2` entirely, so it holds a doc
    // replica by construction - `true` is a fact about every such caller, not
    // a default (`tui-agent-records.ts`'s own doc on the upgrade path).
    const upgraded = epicListTuiAgentsUpgradeV10ToV11.upgradeRequest({
      epicId: "epic-1",
    });

    expect(listTuiAgentsRequestV11Schema.parse(upgraded)).toEqual({
      epicId: "epic-1",
      hasDocReplica: true,
    });
  });

  it("fills docResident: false on an upgraded v1.0 response", () => {
    // A `@1.0` host can only ever have produced registry rows, so every row
    // it returns is registry-backed by construction.
    const upgraded = epicListTuiAgentsUpgradeV10ToV11.upgradeResponse({
      tuiAgents: [
        {
          tuiAgentId: "tui-1",
          ownerUserId: "user-1",
          hostId: "host-1",
          harnessId: "claude",
          harnessSessionId: null,
          parentId: null,
          title: "An agent",
          isTitleEditedByUser: false,
          createdAt: 1,
          updatedAt: 2,
          archived: false,
          archivedAt: null,
          workspaceFolders: [],
          workspaceMode: null,
          model: null,
          reasoningEffort: null,
          agentMode: "regular",
          profileId: null,
          terminalAgentArgs: null,
          terminalShellCommand: null,
          terminalShellArgs: null,
          revision: 1,
        },
      ],
    });

    const parsed = listTuiAgentsResponseV11Schema.parse(upgraded);
    expect(parsed.tuiAgents.map((row) => row.docResident)).toEqual([false]);
  });

  it("imports the host RPC registry cleanly with epic.listTuiAgents@1.1 registered", () => {
    // A bad version annotation on this contract throws at MODULE IMPORT for
    // every consumer of `hostRpcRegistry` - the whole app reports "0 tests
    // collected" rather than a pointed registry error. Asserting the method
    // is actually present (not just that the import didn't throw) is what
    // pins `assertSchemaCompatibility` having accepted this pair rather than
    // this test having imported nothing.
    const majorLine = hostRpcRegistry["epic.listTuiAgents"][1];
    expect(majorLine.latestMinor).toBe(1);
    expect(majorLine.versions[1].contract.schemaVersion).toEqual({
      major: 1,
      minor: 1,
    });
  });
});
