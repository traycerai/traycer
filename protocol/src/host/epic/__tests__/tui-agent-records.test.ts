import { describe, expect, it } from "vitest";
import {
  epicListTuiAgentsUpgradeV10ToV11,
  epicListTuiAgentsUpgradeV11ToV12,
  listTuiAgentsRequestV11Schema,
  listTuiAgentsResponseV11Schema,
  listTuiAgentsResponseV12Schema,
  tuiAgentRecordSummaryV11Schema,
  tuiAgentRecordSummaryV12Schema,
  type TuiAgentRecordSummaryV11,
} from "@traycer/protocol/host/epic/tui-agent-records";
import { hostRpcRegistry } from "@traycer/protocol/host/index";

/** A full-shaped `@1.1` row, the shape both local origins still carry at `@1.2`. */
const V11_ROW: TuiAgentRecordSummaryV11 = {
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
  docResident: false,
};

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
    expect(majorLine.latestMinor).toBe(2);
    expect(majorLine.versions[1].contract.schemaVersion).toEqual({
      major: 1,
      minor: 1,
    });
  });
});

describe("epic.listTuiAgents@1.2 origin union", () => {
  it("admits the two full-shaped local arms and keeps them distinguishable", () => {
    const registry = tuiAgentRecordSummaryV12Schema.parse({
      ...V11_ROW,
      origin: "registry",
    });
    const doc = tuiAgentRecordSummaryV12Schema.parse({
      ...V11_ROW,
      docResident: true,
      origin: "doc",
    });

    expect(registry.origin).toBe("registry");
    expect(doc.origin).toBe("doc");
    // `docResident` survives the widening, because a `@1.1` peer's schema
    // still requires it and there is no per-minor response downgrade.
    expect(registry).toHaveProperty("docResident", false);
    expect(doc).toHaveProperty("docResident", true);
  });

  it("admits the narrow cloud arm WITHOUT the fields a replica cannot answer", () => {
    const cloud = tuiAgentRecordSummaryV12Schema.parse({
      origin: "cloud",
      tuiAgentId: "tui-2",
      ownerUserId: "user-1",
      hostId: "host-2",
      harnessId: "claude",
      parentId: null,
      title: "A remote agent",
      isTitleEditedByUser: false,
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      revision: 7,
    });

    expect(cloud.origin).toBe("cloud");
    // The absences are the contract, not an oversight: no resume metadata
    // crosses the cloud metadata projection, which is what makes cloning a
    // replica structurally impossible rather than merely unimplemented.
    expect(cloud).not.toHaveProperty("harnessSessionId");
    expect(cloud).not.toHaveProperty("workspaceFolders");
    expect(cloud).not.toHaveProperty("agentMode");
    expect(cloud).not.toHaveProperty("archivedAt");
  });

  it("accepts a cloud row whose harness the cloud projection never carried", () => {
    // `harnessId` is read off `runSettingsSummary`, which a row written before
    // that field existed does not have. Nullable here and required on the
    // local arms: the roster shows the agent without a harness mark rather
    // than dropping it.
    const parsed = tuiAgentRecordSummaryV12Schema.safeParse({
      origin: "cloud",
      tuiAgentId: "tui-2",
      ownerUserId: "user-1",
      hostId: "host-2",
      harnessId: null,
      parentId: null,
      title: "",
      isTitleEditedByUser: false,
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      revision: 7,
    });

    expect(parsed.success).toBe(true);
  });

  it("refuses a cloud row that omits its binding host", () => {
    // The binding host is how the row is ADDRESSED - live attach, and the
    // offline banner alike. A replica with no host could not be either.
    const parsed = tuiAgentRecordSummaryV12Schema.safeParse({
      origin: "cloud",
      tuiAgentId: "tui-2",
      ownerUserId: "user-1",
      hostId: "",
      harnessId: "claude",
      parentId: null,
      title: "",
      isTitleEditedByUser: false,
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      revision: 7,
    });

    expect(parsed.success).toBe(false);
  });

  it("keeps the @1.1 row parseable, so a @1.1 client is unaffected by the widening", () => {
    // The registry arm is the `@1.1` row plus one key, and an added plain
    // object key is stripped by an older peer's schema. This is the property
    // the minor's additivity rests on.
    const served = tuiAgentRecordSummaryV12Schema.parse({
      ...V11_ROW,
      origin: "registry",
    });

    expect(tuiAgentRecordSummaryV11Schema.parse(served)).toEqual(V11_ROW);
  });
});

describe("epic.listTuiAgents v1.1 -> v1.2 upgrade path", () => {
  it("derives origin from docResident rather than defaulting it", () => {
    const upgraded = epicListTuiAgentsUpgradeV11ToV12.upgradeResponse({
      tuiAgents: [
        V11_ROW,
        { ...V11_ROW, tuiAgentId: "tui-2", docResident: true },
      ],
    });

    expect(listTuiAgentsResponseV12Schema.parse(upgraded).tuiAgents).toEqual([
      { ...V11_ROW, origin: "registry" },
      {
        ...V11_ROW,
        tuiAgentId: "tui-2",
        docResident: true,
        origin: "doc",
      },
    ]);
  });

  it("never invents a cloud row, because a @1.1 host cannot serve one", () => {
    // The inbox arm that produces a replica ships in the same host build as
    // this minor, so `cloud` is unreachable through the upgrade path by
    // construction - not merely absent from this fixture.
    const upgraded = epicListTuiAgentsUpgradeV11ToV12.upgradeResponse({
      tuiAgents: [V11_ROW, { ...V11_ROW, docResident: true }],
    });

    expect(upgraded.tuiAgents.every((row) => row.origin !== "cloud")).toBe(
      true,
    );
  });

  it("leaves the request untouched", () => {
    // `hasDocReplica` answers what the caller already HOLDS; `@1.2` gates on
    // what it can PARSE, which is the negotiated version. Different questions,
    // so the request needs nothing.
    expect(
      epicListTuiAgentsUpgradeV11ToV12.upgradeRequest({
        epicId: "epic-1",
        hasDocReplica: false,
      }),
    ).toEqual({ epicId: "epic-1", hasDocReplica: false });
  });
});
