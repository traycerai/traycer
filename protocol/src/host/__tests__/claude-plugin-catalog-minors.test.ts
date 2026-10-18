import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentGuiListCommandsUpgradeV10ToV11 } from "@traycer/protocol/host/agent/gui/contracts";
import {
  listGuiAgentCommandsRequestSchema,
  listGuiAgentCommandsRequestSchemaV11,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import { providerPluginsCapabilitiesSchema } from "@traycer/protocol/host/provider-native-schemas";
import {
  providerCliStateSchema,
  providersListResponseSchema,
  providersListResponseSchemaV70,
  providersListResponseSchemaV80,
  providersListResponseSchemaV90,
  providersListResponseSchemaV91,
  providersListResponseSchemaV92,
  providersListResponseSchemaV102Preimage,
} from "@traycer/protocol/host/provider-schemas";
import { hostRpcRegistry } from "@traycer/protocol/host/index";

const plugins = {
  addModes: ["marketplace"],
  marketplaceBrowse: true,
  actionScopes: {
    list: ["global"],
    add: ["global"],
    remove: ["global"],
    setEnabled: ["global"],
  },
  traycerSessionToolsNotice: false,
} as const;

describe("Claude plugin and command catalog minors", () => {
  it("decodes an old plugin capability without blanking the other fields", () => {
    const decoded = providerPluginsCapabilitiesSchema.parse(plugins);
    const row = providerCliStateSchema.parse({
      providerId: "claude-code",
      enabled: true,
      disabledBy: null,
      selected: { kind: "bundled" },
      candidates: [],
      auth: { status: "unknown", badgeText: null, label: null, detail: null },
      authPending: false,
      checkedAt: null,
      apiKey: { supported: false, configured: false, source: null },
      terminalAgentArgs: "",
      envOverrides: [],
      loginCapability: null,
      profiles: [],
      nativeCapabilities: {
        supportedTabs: ["plugins"],
        mcp: null,
        plugins,
        skills: null,
        modelProviders: null,
      },
    });
    expect(decoded.openChatsApplyNextMessage).toBe(false);
    expect(row.nativeCapabilities.plugins?.openChatsApplyNextMessage).toBe(
      false,
    );
    expect(row.nativeCapabilities.plugins?.actionScopes.add).toEqual([
      "global",
    ]);
    expect(row.nativeCapabilities.supportedTabs).toEqual(["plugins"]);
  });

  it("freezes the 10.2 provider response before the open-chat field", () => {
    expect(hostRpcRegistry["providers.list"][10].latestMinor).toBe(3);
    expect(
      hostRpcRegistry["providers.list"][10].versions[2].contract.responseSchema,
    ).toBe(providersListResponseSchemaV102Preimage);
    expect(
      hostRpcRegistry["providers.list"][10].versions[3].contract.responseSchema,
    ).toBe(providersListResponseSchema);
  });

  it("keeps the open-chat field out of released 7–9 provider responses", () => {
    for (const schema of [
      providersListResponseSchemaV70,
      providersListResponseSchemaV80,
      providersListResponseSchemaV90,
      providersListResponseSchemaV91,
      providersListResponseSchemaV92,
    ]) {
      expect(
        JSON.stringify(z.toJSONSchema(schema, { unrepresentable: "any" })),
      ).not.toContain("openChatsApplyNextMessage");
    }
  });

  it("defaults the 1.0 command request to ambient and keeps 1.0 parsing compatible", () => {
    const v10 = {
      harnessId: "claude" as const,
      workingDirectory: "/tmp/workspace",
      workingDirectories: ["/tmp/workspace"],
    };
    expect(agentGuiListCommandsUpgradeV10ToV11.upgradeRequest(v10)).toEqual({
      ...v10,
      profileId: null,
    });
    expect(
      listGuiAgentCommandsRequestSchemaV11.parse(v10).profileId,
    ).toBeNull();
    expect(
      listGuiAgentCommandsRequestSchema.parse({
        ...v10,
        profileId: "managed-a",
      }),
    ).toEqual(v10);
    expect(hostRpcRegistry["agent.gui.listCommands"][1].latestMinor).toBe(1);
  });
});
