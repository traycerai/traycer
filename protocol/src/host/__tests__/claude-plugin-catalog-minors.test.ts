import { describe, expect, it } from "vitest";
import { agentGuiListCommandsUpgradeV10ToV11 } from "@traycer/protocol/host/agent/gui/contracts";
import {
  listGuiAgentCommandsRequestSchema,
  listGuiAgentCommandsRequestSchemaV11,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  providerPluginsCapabilitiesSchema,
  type ProviderNativeCapabilities,
} from "@traycer/protocol/host/provider-native-schemas";
import {
  providerCliStateSchema,
  providersListResponseSchema,
  providersListResponseSchemaV70,
  providersListResponseSchemaV80,
  providersListResponseSchemaV90,
  providersListResponseSchemaV91,
  providersListResponseSchemaV92,
  providersListResponseSchemaV102Preimage,
  providersListResponseSchemaV103Preimage,
  providersListResponseSchemaV104Preimage,
} from "@traycer/protocol/host/provider-schemas";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { toCanonicalJsonSchema } from "@traycer/protocol/framework/json-schema-fingerprint";

// A complete capability object as an old host sends it: the plugin block has
// no `openChatsApplyNextMessage`. `satisfies` is the compile-time half of the
// decode assertions below - the exported carrier type must accept this shape,
// so a carrier that requires the field again fails protocol compile here.
const legacyNativeCapabilities = {
  supportedTabs: ["plugins"],
  mcp: null,
  plugins: {
    addModes: ["marketplace"],
    marketplaceBrowse: true,
    actionScopes: {
      list: ["global"],
      add: ["global"],
      remove: ["global"],
      setEnabled: ["global"],
    },
    traycerSessionToolsNotice: false,
  },
  skills: null,
  modelProviders: null,
} satisfies ProviderNativeCapabilities;
const plugins = legacyNativeCapabilities.plugins;

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
      nativeCapabilities: legacyNativeCapabilities,
    });
    // Optional on the wire: absent decodes to undefined, which every reader
    // treats as "not opted in" (only an explicit true opts in).
    expect(decoded.openChatsApplyNextMessage === true).toBe(false);
    expect(
      row.nativeCapabilities.plugins?.openChatsApplyNextMessage === true,
    ).toBe(false);
    expect(row.nativeCapabilities.plugins?.actionScopes.add).toEqual([
      "global",
    ]);
    expect(row.nativeCapabilities.supportedTabs).toEqual(["plugins"]);
  });

  it("keeps Kilo's published 10.3 and Claude's 10.4 below the live 10.5", () => {
    expect(hostRpcRegistry["providers.list"][10].latestMinor).toBe(5);
    expect(
      hostRpcRegistry["providers.list"][10].versions[2].contract.responseSchema,
    ).toBe(providersListResponseSchemaV102Preimage);
    expect(
      hostRpcRegistry["providers.list"][10].versions[3].contract.responseSchema,
    ).toBe(providersListResponseSchemaV103Preimage);
    expect(
      hostRpcRegistry["providers.list"][10].versions[4].contract.responseSchema,
    ).toBe(providersListResponseSchemaV104Preimage);
    expect(
      hostRpcRegistry["providers.list"][10].versions[5].contract.responseSchema,
    ).toBe(providersListResponseSchema);
    expect(
      JSON.stringify(
        toCanonicalJsonSchema(providersListResponseSchemaV103Preimage, {
          unrepresentable: "any",
        }),
      ),
    ).not.toContain("openChatsApplyNextMessage");
  });

  it("decodes an old-host row on the live 10.5 response and drops an explicit true on the frozen 10.3 one", () => {
    const row = (nativeCapabilities: unknown) => ({
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
      nativeCapabilities,
    });
    const live = providersListResponseSchema.parse({
      providers: [row(legacyNativeCapabilities)],
      native: null,
    });
    expect(
      live.providers[0].nativeCapabilities.plugins
        ?.openChatsApplyNextMessage === true,
    ).toBe(false);
    expect(live.providers[0].nativeCapabilities.supportedTabs).toEqual([
      "plugins",
    ]);

    const advertised = {
      ...legacyNativeCapabilities,
      plugins: {
        ...legacyNativeCapabilities.plugins,
        openChatsApplyNextMessage: true,
      },
    };
    expect(
      providersListResponseSchema.parse({
        providers: [row(advertised)],
        native: null,
      }).providers[0].nativeCapabilities.plugins?.openChatsApplyNextMessage,
    ).toBe(true);
    const frozen = providersListResponseSchemaV103Preimage.parse({
      providers: [row(advertised)],
      native: null,
    });
    expect(
      "openChatsApplyNextMessage" in
        (frozen.providers[0].nativeCapabilities.plugins ?? {}),
    ).toBe(false);
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
        JSON.stringify(
          toCanonicalJsonSchema(schema, { unrepresentable: "any" }),
        ),
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
