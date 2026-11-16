import { describe, expect, it } from "vitest";
import { downgradeResponseAcrossMajors } from "@traycer/protocol/framework/index";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { providerManagedVersionsSchema } from "@traycer/protocol/host/provider-schemas";

const harnessRow = (id: string) => ({
  id,
  label: id === "muse" ? "Muse Code" : "Command Code",
  available: true,
  error: null,
  modes: ["gui"],
  requiresApiKey: false,
  supportedPermissionModes: ["supervised", "auto_accept_edits", "full_access"],
});

describe("Muse registry negotiation", () => {
  it("retains Muse pack sharing on the live version manager", () => {
    const versions = providerManagedVersionsSchema.parse({
      autoDownload: true,
      pinnedVersion: null,
      updateAvailable: null,
      sharedWithProviders: ["opencode", "muse"],
      totalSizeBytes: null,
      available: [],
    });
    expect(versions.sharedWithProviders).toEqual(["opencode", "muse"]);
  });

  it("advertises Muse on the new catalog and drops only its row for major 10", () => {
    const method = hostRpcRegistry["agent.gui.listHarnesses"];
    const response = method[11].versions[0].contract.responseSchema.parse({
      harnesses: [harnessRow("commandcode"), harnessRow("muse")],
    });
    expect(response.harnesses.map((row) => row.id)).toEqual([
      "commandcode",
      "muse",
    ]);
    const result = downgradeResponseAcrossMajors(method, 11, 10, response);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.harnesses).toEqual([response.harnesses[0]]);
    expect(
      method[10].versions[1].contract.responseSchema.safeParse(response)
        .success,
    ).toBe(false);
  });

  it("refuses a Muse profile response on the previous major", () => {
    const method = hostRpcRegistry["agent.listProviderProfiles"];
    const response = method[8].versions[0].contract.responseSchema.parse({
      providerId: "muse",
      profiles: [],
    });
    const result = downgradeResponseAcrossMajors(method, 8, 7, response);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Muse profile unexpectedly reached major 7");
    expect(result.error.code).toBe("DOWNGRADE_UNSUPPORTED");
    expect(result.error.message).not.toMatch(/muse/i);
  });

  it("negotiates unavailable Muse rate limits only on the new head", () => {
    const method = hostRpcRegistry["host.getRateLimitUsage"];
    const response = method[7].versions[0].contract.responseSchema.parse({
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: {
        provider: "muse",
        available: false,
        reason: "unsupported_provider",
      },
    });
    expect(response.providerRateLimits?.provider).toBe("muse");
    expect(
      method[6].versions[0].contract.responseSchema.safeParse(response).success,
    ).toBe(false);
  });

  it("keeps session import 1.3 closed and opens 1.4", () => {
    const method = hostStreamRpcRegistry["sessionImport.scan"][1];
    const frame = {
      kind: "started",
      providers: ["muse"],
      hasBinaryPayload: false,
    };
    expect(
      method.versions[3].contract.serverFrameSchema.safeParse(frame).success,
    ).toBe(false);
    expect(method.versions[4].contract.serverFrameSchema.parse(frame)).toEqual(
      frame,
    );
  });
});
