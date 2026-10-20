import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  agentGuiListHarnessesUpgradeV100ToV101,
  agentGuiListHarnessesV100,
  agentGuiListHarnessesV101,
} from "@traycer/protocol/host/agent/gui/contracts";
import type { GuiHarnessSandboxCredentialMode } from "@traycer/protocol/host/agent/gui/unary-schemas";

/**
 * `agent.gui.listHarnesses@10.1`: the row's `sandboxCredentialMode` and
 * `sandboxCredentialNote`. Both are new KEYS, stripped by the frozen 10.0
 * re-parse, and the mode carries `.catch(null)` so a newer host's wider enum
 * reads as "told nothing" instead of failing the catalog.
 */

const BASE_ROW = {
  id: "claude",
  label: "Claude",
  enabled: true,
  available: true,
  error: null,
  unavailableReason: null,
  modes: ["gui"],
  requiresApiKey: false,
  supportedPermissionModes: ["auto"],
  nativeAutoJudge: false,
  judgeDefaultModel: null,
  availabilityPending: false,
  authStatus: "authenticated",
};

describe("agent.gui.listHarnesses@10.1 registry binding", () => {
  it("declares 10.1 as the head line, with 10.0 below it", () => {
    expect(agentGuiListHarnessesV101.schemaVersion).toEqual({
      major: 10,
      minor: 1,
    });
    const head = hostRpcRegistry["agent.gui.listHarnesses"][10];
    expect(head.latestMinor).toBe(1);
    expect(head.versions[1].contract).toBe(agentGuiListHarnessesV101);
    expect(head.versions[0].contract).toBe(agentGuiListHarnessesV100);
  });
});

describe("agent.gui.listHarnesses@10.1 keeps the sandbox credential fields", () => {
  const MODES: readonly GuiHarnessSandboxCredentialMode[] = [
    "placeholder",
    "process-scoped",
    "unsupported",
  ];

  it.each(MODES)("keeps sandboxCredentialMode %s", (mode) => {
    const parsed = agentGuiListHarnessesV101.responseSchema.parse({
      harnesses: [{ ...BASE_ROW, sandboxCredentialMode: mode }],
    });
    expect(parsed.harnesses[0]?.sandboxCredentialMode).toBe(mode);
  });

  it("keeps sandboxCredentialNote", () => {
    const parsed = agentGuiListHarnessesV101.responseSchema.parse({
      harnesses: [
        {
          ...BASE_ROW,
          sandboxCredentialMode: "unsupported",
          sandboxCredentialNote:
            "Uses a keychain entry the gateway cannot swap",
        },
      ],
    });
    expect(parsed.harnesses[0]?.sandboxCredentialNote).toBe(
      "Uses a keychain entry the gateway cannot swap",
    );
  });

  it("keeps a null mode and a null note", () => {
    const parsed = agentGuiListHarnessesV101.responseSchema.parse({
      harnesses: [
        {
          ...BASE_ROW,
          sandboxCredentialMode: null,
          sandboxCredentialNote: null,
        },
      ],
    });
    expect(parsed.harnesses[0]?.sandboxCredentialMode).toBeNull();
    expect(parsed.harnesses[0]?.sandboxCredentialNote).toBeNull();
  });

  it("parses a row from an older host that carries neither key", () => {
    const parsed = agentGuiListHarnessesV101.responseSchema.safeParse({
      harnesses: [BASE_ROW],
    });
    expect(parsed.success).toBe(true);
    const row = agentGuiListHarnessesV101.responseSchema.parse({
      harnesses: [BASE_ROW],
    }).harnesses[0];
    expect(row?.sandboxCredentialMode ?? null).toBeNull();
    expect(row?.sandboxCredentialNote ?? null).toBeNull();
  });

  it("reads an unknown mode as null instead of dropping the row", () => {
    const parsed = agentGuiListHarnessesV101.responseSchema.parse({
      harnesses: [{ ...BASE_ROW, sandboxCredentialMode: "future-mode" }],
    });
    expect(parsed.harnesses).toHaveLength(1);
    expect(parsed.harnesses[0]?.id).toBe("claude");
    expect(parsed.harnesses[0]?.sandboxCredentialMode).toBeNull();
  });
});

describe("agent.gui.listHarnesses@10.0 frozen response", () => {
  it("strips both sandbox credential keys from a row that carries them", () => {
    const parsed = agentGuiListHarnessesV100.responseSchema.parse({
      harnesses: [
        {
          ...BASE_ROW,
          sandboxCredentialMode: "placeholder",
          sandboxCredentialNote: "note",
        },
      ],
    });
    const row = parsed.harnesses[0];
    expect(row).toBeDefined();
    expect(Object.hasOwn(row ?? {}, "sandboxCredentialMode")).toBe(false);
    expect(Object.hasOwn(row ?? {}, "sandboxCredentialNote")).toBe(false);
    expect(row?.id).toBe("claude");
  });
});

describe("agent.gui.listHarnesses 10.0 -> 10.1 upgrade", () => {
  it("maps a 10.0 response to an equal 10.1 response", () => {
    const v100 = agentGuiListHarnessesV100.responseSchema.parse({
      harnesses: [BASE_ROW],
    });
    const upgraded =
      agentGuiListHarnessesUpgradeV100ToV101.upgradeResponse(v100);
    expect(upgraded).toEqual(v100);
    expect(
      agentGuiListHarnessesV101.responseSchema.safeParse(upgraded).success,
    ).toBe(true);
  });
});
