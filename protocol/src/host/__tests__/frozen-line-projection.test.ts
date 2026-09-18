import { describe, expect, it } from "vitest";
import { downgradeResponseAcrossMajors } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { projectOntoFrozenLine } from "@traycer/protocol/host/frozen-line-projection";
import {
  providerCliStateSchemaV70,
  providerCliStateSchemaV80,
  providersListResponseSchema,
  providersListResponseSchemaV70,
} from "@traycer/protocol/host/provider-schemas";
import {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70_PREIMAGE,
  providerNativeCapabilitiesSchema,
  providerNativeCapabilitiesSchemaV70Preimage,
} from "@traycer/protocol/host/provider-native-schemas";

/**
 * A downgrade bridge reparses the live response through the frozen schema of
 * the line it serves. That reparse strips an added KEY correctly and handles an
 * added ENUM MEMBER catastrophically: `z.array(enum)` rejects the whole array
 * over one unknown element, and the nearest `.catch()` then serves its default
 * in place of everything that array was nested inside.
 *
 * Every test below therefore states BOTH halves - what the frozen schema does
 * to the value on its own (the control, which is the behaviour that shipped)
 * and what it does after {@link projectOntoFrozenLine}. Without the control a
 * green assertion here would not distinguish "the projection saved the
 * siblings" from "there was nothing to save".
 */

function providerState(providerId: string) {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" as const },
    candidates: [],
    auth: {
      status: "unknown" as const,
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
  };
}

function nativeMcpResultWithDenySources(denySources: readonly string[]) {
  return {
    kind: "mcp",
    ok: true,
    servers: [
      {
        name: "s",
        enabled: true,
        status: "connected",
        statusDetail: null,
        statusSource: "native",
        configOnly: false,
        discoveryPending: false,
        stdioDegraded: false,
        instructions: null,
        transport: { type: "stdio", command: "x", env: null },
        tools: [
          {
            name: "t",
            description: null,
            inputSchema: null,
            enabled: true,
            readOnly: false,
            denySources,
          },
        ],
      },
    ],
  };
}

describe("projectOntoFrozenLine", () => {
  it("returns an already-valid value by identity, without copying it", () => {
    // The overwhelmingly common case: nothing has drifted. It must cost one
    // parse and must not clone a whole provider list to achieve nothing.
    const valid = {
      ...DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
      supportedTabs: ["general", "mcp"],
    };
    expect(projectOntoFrozenLine(providerNativeCapabilitiesSchema, valid)).toBe(
      valid,
    );
  });

  it("leaves a value it cannot repair untouched, so the caller's catch still rules", () => {
    // A SCALAR enum has no member to drop. Inventing a substitute would be a
    // bridge fabricating wire content, so the value passes through unchanged
    // and the existing `.catch()` handles it exactly as it does today.
    const unrepairable = {
      ...DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
      supportedTabs: ["general"],
      envOverrideScope: "not-a-real-scope",
    };
    const projected = projectOntoFrozenLine(
      providerNativeCapabilitiesSchemaV70Preimage,
      unrepairable,
    );
    expect(projected).toMatchObject({ envOverrideScope: "not-a-real-scope" });
    expect(
      providerNativeCapabilitiesSchemaV70Preimage
        .catch(DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70_PREIMAGE)
        .parse(projected).supportedTabs,
    ).toEqual(DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70_PREIMAGE.supportedTabs);
  });

  it("drops one unknown tab instead of the whole capability object", () => {
    // `modelProviders` is a real member the live tab enum has and the frozen
    // pre-image enum does not - a growth that already happened, so this is a
    // natural experiment rather than an invented value.
    const grown = {
      ...DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
      supportedTabs: ["general", "mcp", "modelProviders"],
    };

    // CONTROL: the reparse alone. One unknown member costs the peer every tab.
    expect(
      providerNativeCapabilitiesSchemaV70Preimage
        .catch(DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70_PREIMAGE)
        .parse(grown).supportedTabs,
    ).toEqual(["general", "env", "usage"]);

    // With the projection the peer keeps the tabs its own build understands.
    const projected = projectOntoFrozenLine(
      providerNativeCapabilitiesSchemaV70Preimage,
      grown,
    );
    expect(
      providerNativeCapabilitiesSchemaV70Preimage
        .catch(DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70_PREIMAGE)
        .parse(projected).supportedTabs,
    ).toEqual(["general", "mcp"]);
  });
});

describe("providers.list downgrade keeps what a frozen line CAN represent", () => {
  it("keeps the shared-pack ids a v8.0 peer knows when one id is newer than the line", () => {
    // Reachable TODAY, with no invented values: `antigravity` is a live
    // provider id that `providers.list@8.0` does not carry, and a pack shared
    // between it and `claude-code` is an ordinary host response.
    const state = {
      ...providerState("claude-code"),
      packId: "pack-a",
      managedVersions: {
        autoDownload: true,
        pinnedVersion: null,
        updateAvailable: null,
        sharedWithProviders: ["claude-code", "antigravity"],
        totalSizeBytes: null,
        available: [],
      },
    };

    // CONTROL: `sharedWithProviders` is `z.array(providerId).catch([])`, so the
    // unknown id costs the peer the id it DID know as well.
    const withoutProjection = providerCliStateSchemaV80.parse(state);
    expect(withoutProjection.managedVersions?.sharedWithProviders).toEqual([]);

    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      9,
      8,
      providersListResponseSchema.parse({ providers: [state], native: null }),
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    const row = downgraded.value.providers[0];
    expect(row?.managedVersions?.sharedWithProviders).toEqual(["claude-code"]);
  });

  it("drops only the newer id for a v7.0 peer, which is two majors behind", () => {
    const state = {
      ...providerState("claude-code"),
      packId: "pack-a",
      managedVersions: {
        autoDownload: true,
        pinnedVersion: null,
        updateAvailable: null,
        // v7.0 lacks BOTH of these; the projection must drop both and keep the
        // one it knows rather than stopping at the first failure.
        sharedWithProviders: ["claude-code", "reasonix", "antigravity"],
        totalSizeBytes: null,
        available: [],
      },
    };
    expect(
      providerCliStateSchemaV70.parse(state).managedVersions
        ?.sharedWithProviders,
    ).toEqual([]);

    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      9,
      7,
      providersListResponseSchema.parse({ providers: [state], native: null }),
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(
      downgraded.value.providers[0]?.managedVersions?.sharedWithProviders,
    ).toEqual(["claude-code"]);
  });

  it("serves the response at all when a deny source outgrows the line", () => {
    // `native.servers[].tools[].denySources[]` is the one measured leaf with NO
    // `.catch()` between it and the root, so growth there does not degrade the
    // response - it THROWS, and the peer's whole providers.list call fails.
    const response = {
      providers: [],
      native: nativeMcpResultWithDenySources(["user", "future-source"]),
    };

    // CONTROL: the plain frozen parse the bridge used to do.
    expect(() => providersListResponseSchemaV70.parse(response)).toThrow();

    const projected = projectOntoFrozenLine(
      providersListResponseSchemaV70,
      response,
    );
    const parsed = providersListResponseSchemaV70.parse(projected);
    expect(parsed.native).not.toBeNull();
    // The server, its tool and the deny source the line knows all survive; only
    // the member it cannot represent is gone.
    expect(parsed.native).toMatchObject({
      kind: "mcp",
      servers: [{ name: "s", tools: [{ name: "t", denySources: ["user"] }] }],
    });
  });

  it("still drops a whole row when the row itself is unrepresentable", () => {
    // The projection must not rescue what the freeze exists to exclude: a
    // post-v7.0 provider id is a SCALAR on the row, so the row still fails and
    // the bridge still filters it out. This is the behaviour that keeps new
    // providers off an already-shipped wire.
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      9,
      7,
      providersListResponseSchema.parse({
        providers: [providerState("claude-code"), providerState("antigravity")],
        native: null,
      }),
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value.providers.map((p) => p.providerId)).toEqual([
      "claude-code",
    ]);
  });
});
