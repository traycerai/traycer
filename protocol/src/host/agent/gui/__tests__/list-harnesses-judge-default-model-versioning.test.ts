import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  agentGuiListHarnessesUpgradeV91ToV92,
  agentGuiListHarnessesV91,
  agentGuiListHarnessesV92,
} from "@traycer/protocol/host/agent/gui/contracts";
import {
  listGuiHarnessesResponseSchema,
  listGuiHarnessesResponseSchemaV91,
  type GuiHarnessOption,
} from "@traycer/protocol/host/agent/gui/unary-schemas";

/**
 * `agent.gui.listHarnesses@9.2`: the catalog row's `judgeDefaultModel`, the
 * model Traycer's judge runs on when Automatic falls back to that harness.
 * See `contracts.ts`'s docblock on `agentGuiListHarnessesV92` for why this is
 * a new KEY (stripped by the within-major re-parse) rather than an emission
 * gate like 9.1's `supportedPermissionModes` growth.
 */

function liveRowWithJudgeDefaultModel(): GuiHarnessOption {
  return {
    id: "claude",
    label: "Claude",
    enabled: false,
    available: true,
    error: "boom",
    unavailableReason: "missing-binary",
    modes: ["gui"],
    requiresApiKey: true,
    supportedPermissionModes: ["auto"],
    nativeAutoJudge: true,
    judgeDefaultModel: "some-cheap-model",
    availabilityPending: true,
    authStatus: "authenticated",
  };
}

describe("agent.gui.listHarnesses registry: 9.1 frozen, 9.2 the head", () => {
  it("binds the frozen 9.1 line and its response schema", () => {
    const entry = hostRpcRegistry["agent.gui.listHarnesses"][9];
    expect(entry.latestMinor).toBe(2);
    expect(entry.versions[1].contract).toBe(agentGuiListHarnessesV91);
    expect(entry.versions[1].contract.responseSchema).toBe(
      listGuiHarnessesResponseSchemaV91,
    );
    expect(entry.versions[1].responseGrowthProjectionGated).toBe(true);
  });

  it("binds the live 9.2 line, with no growth-projection annotation", () => {
    const entry = hostRpcRegistry["agent.gui.listHarnesses"][9];
    expect(entry.versions[2].contract).toBe(agentGuiListHarnessesV92);
    expect(entry.versions[2].contract.responseSchema).toBe(
      listGuiHarnessesResponseSchema,
    );
    expect(
      Object.hasOwn(entry.versions[2], "responseGrowthProjectionGated"),
    ).toBe(false);
  });
});

describe("agent.gui.listHarnesses@9.2 -> 9.1: stripping judgeDefaultModel", () => {
  it("the 9.1 within-major re-parse strips judgeDefaultModel and nothing else", () => {
    const row = liveRowWithJudgeDefaultModel();
    const v92 = agentGuiListHarnessesV92.responseSchema.parse({
      harnesses: [row],
    });

    const v91 = agentGuiListHarnessesV91.responseSchema.parse(v92);

    const { judgeDefaultModel: _dropped, ...expectedRow } = v92.harnesses[0];
    expect(v91.harnesses[0]).toEqual(expectedRow);
    expect(Object.hasOwn(v91.harnesses[0], "judgeDefaultModel")).toBe(false);
  });

  it("does the same strip when judgeDefaultModel is explicitly null", () => {
    const row = { ...liveRowWithJudgeDefaultModel(), judgeDefaultModel: null };
    const v92 = agentGuiListHarnessesV92.responseSchema.parse({
      harnesses: [row],
    });

    const v91 = agentGuiListHarnessesV91.responseSchema.parse(v92);

    const { judgeDefaultModel: _dropped, ...expectedRow } = v92.harnesses[0];
    expect(v91.harnesses[0]).toEqual(expectedRow);
    expect(Object.hasOwn(v91.harnesses[0], "judgeDefaultModel")).toBe(false);
  });

  it("leaves an absent judgeDefaultModel absent on 9.2 itself", () => {
    const { judgeDefaultModel: _omit, ...rowWithoutJudgeModel } =
      liveRowWithJudgeDefaultModel();
    const v92 = agentGuiListHarnessesV92.responseSchema.parse({
      harnesses: [rowWithoutJudgeModel],
    });
    expect(Object.hasOwn(v92.harnesses[0], "judgeDefaultModel")).toBe(false);
  });
});

describe("agent.gui.listHarnesses 9.1 -> 9.2 upgrade", () => {
  it("is identity on a 9.1 response", () => {
    const { judgeDefaultModel: _dropped, ...v91Row } =
      liveRowWithJudgeDefaultModel();
    const v91Response = listGuiHarnessesResponseSchemaV91.parse({
      harnesses: [v91Row],
    });
    expect(
      agentGuiListHarnessesUpgradeV91ToV92.upgradeResponse(v91Response),
    ).toBe(v91Response);
  });
});

describe("agent.gui.listHarnesses@9.2 downgrade bridges strip judgeDefaultModel too", () => {
  it("every downgradePathsFromLatest[N] under major 9 declares from 9.2", () => {
    const entry = hostRpcRegistry["agent.gui.listHarnesses"][9];
    const paths = entry.downgradePathsFromLatest;
    for (const targetMajor of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
      const path = paths[targetMajor];
      expect(path).toBeDefined();
      expect(path?.from).toEqual({ major: 9, minor: 2 });
    }
  });

  it("every 9->N bridge drops rows' judgeDefaultModel on a live response", () => {
    const row = liveRowWithJudgeDefaultModel();
    const v92 = agentGuiListHarnessesV92.responseSchema.parse({
      harnesses: [row],
    });

    const entry = hostRpcRegistry["agent.gui.listHarnesses"][9];
    for (const targetMajor of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
      const path = entry.downgradePathsFromLatest[targetMajor];
      expect(path).toBeDefined();
      if (path === undefined) throw new Error("unreachable");
      const result = path.downgradeResponse(v92);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected the downgrade to succeed");
      const downgradedRow = result.value.harnesses[0] as Record<
        string,
        unknown
      >;
      expect(downgradedRow).toBeDefined();
      expect(Object.hasOwn(downgradedRow, "judgeDefaultModel")).toBe(false);
    }
  });
});
