import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  nativeListResultSchema,
  nativeListResultSchemaBeforeMcpRemedies,
  nativeMutationResultSchemaV10Preimage,
  nativeMutationSchemaV10Preimage,
  providerMcpCapabilitiesSchema,
  providerMcpNoticeSchema,
  providerMcpServerSchema,
  providerMcpServerSchemaV70Preimage,
  providerNativeCapabilitiesSchema,
  providerNativeCapabilitiesSchemaBeforeMcpRemedies,
  nativeMutationResultSchema,
  nativeMutationSchema,
} from "@traycer/protocol/host/provider-native-schemas";
import {
  providersNativeMutateRequestSchema,
  providersNativeMutateRequestSchemaV10Preimage,
  providersNativeMutateRequestSchemaV11,
} from "@traycer/protocol/host/provider-schemas";

/**
 * Kimi native MCP, step 1 (design: kimi-mcp-native-support, Revision 3 + F9).
 *
 * Every MCP row, list/mutation notice and the `applyRemedy` action is ADDED
 * data, so each released carrier has to keep the shape it shipped: a released
 * reader never receives a field it cannot spell, and a new reader tolerates a
 * host that predates the field. The frozen-catalog dumps pin the JSON shape;
 * these cases pin the behaviour the registry actually negotiates.
 */

const REMEDY = {
  id: "trust-workspace",
  label: "Trust this folder",
  confirmation: "Kimi will run this folder's MCP servers on this machine.",
};
const ENABLE_REMEDY = {
  id: "kimi:enable:stable-target-digest",
  label: "Enable server",
  confirmation: "This server runs a program on this machine.",
};

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "docs",
    enabled: false,
    transport: { type: "http", url: "https://example.com/mcp", auth: null },
    status: "disconnected",
    statusSource: "none",
    statusDetail: null,
    tools: [],
    discoveryPending: false,
    instructions: null,
    configOnly: false,
    stdioDegraded: false,
    ...overrides,
  };
}

const NOTICE = {
  id: "project-untrusted",
  tone: "warning",
  text: "This project is not trusted, so its servers are hidden.",
  blocking: true,
  remedy: REMEDY,
};

const NATIVE_MCP_SCOPES = {
  list: ["global", "project"],
  add: ["global"],
  update: ["global"],
  remove: ["global"],
  toggleServer: ["global"],
  toggleTool: ["global"],
  discover: ["global"],
  auth: ["global"],
};

describe("MCP row remedy fields", () => {
  it("defaults remedy and enableConfirmation when an older host omits them", () => {
    const parsed = providerMcpServerSchema.parse(row({}));
    expect(parsed.remedy ?? null).toBeNull();
    expect(parsed.enableConfirmation ?? null).toBeNull();
  });

  it("carries a row remedy and a stdio enable confirmation", () => {
    const parsed = providerMcpServerSchema.parse(
      row({
        remedy: REMEDY,
        enableConfirmation: ENABLE_REMEDY,
      }),
    );
    expect(parsed.remedy).toEqual(REMEDY);
    expect(parsed.enableConfirmation).toEqual(ENABLE_REMEDY);
  });

  it("requires a bound id for a stdio enable offer", () => {
    expect(
      providerMcpServerSchema.safeParse(
        row({ enableConfirmation: { ...ENABLE_REMEDY, id: "" } }),
      ).success,
    ).toBe(false);
  });

  it("rejects a remedy with an empty id", () => {
    expect(
      providerMcpServerSchema.safeParse(row({ remedy: { ...REMEDY, id: "" } }))
        .success,
    ).toBe(false);
  });

  it("rejects an empty remedy label while allowing an empty confirmation", () => {
    expect(
      providerMcpServerSchema.safeParse(
        row({ remedy: { ...REMEDY, label: "" } }),
      ).success,
    ).toBe(false);
    expect(
      providerMcpServerSchema.safeParse(
        row({ remedy: { ...REMEDY, confirmation: "" } }),
      ).success,
    ).toBe(true);
  });

  it("keeps the released row preimage free of both fields", () => {
    const parsed = providerMcpServerSchemaV70Preimage.parse(
      row({ remedy: REMEDY, enableConfirmation: ENABLE_REMEDY }),
    );
    expect(parsed).not.toHaveProperty("remedy");
    expect(parsed).not.toHaveProperty("enableConfirmation");
  });
});

describe("MCP notices", () => {
  it("accepts a blocking notice with a remedy and a plain informational one", () => {
    expect(providerMcpNoticeSchema.parse(NOTICE)).toEqual(NOTICE);
    const info = {
      id: "env-trust",
      tone: "info",
      text: "Trust is set by an environment variable.",
      blocking: false,
      remedy: null,
    };
    expect(providerMcpNoticeSchema.parse(info)).toEqual(info);
  });

  it.each([
    ["an empty id", { ...NOTICE, id: "" }],
    ["empty notice text", { ...NOTICE, text: "" }],
    ["an unknown tone", { ...NOTICE, tone: "error" }],
    ["a missing blocking flag", { ...NOTICE, blocking: undefined }],
    ["an empty remedy id", { ...NOTICE, remedy: { ...REMEDY, id: "" } }],
  ])("rejects %s", (_label, value) => {
    expect(providerMcpNoticeSchema.safeParse(value).success).toBe(false);
  });

  it("lists a blocking notice with NO rows", () => {
    const parsed = nativeListResultSchema.parse({
      ok: true,
      kind: "mcp",
      servers: [],
      notices: [NOTICE],
    });
    expect(parsed).toMatchObject({ kind: "mcp", servers: [] });
    expect(parsed.ok && parsed.kind === "mcp" ? parsed.notices : null).toEqual([
      NOTICE,
    ]);
  });

  it("defaults notices to none for an old host's list result", () => {
    const parsed = nativeListResultSchema.parse({
      ok: true,
      kind: "mcp",
      servers: [row({})],
    });
    expect(
      parsed.ok && parsed.kind === "mcp" ? (parsed.notices ?? []) : null,
    ).toEqual([]);
  });

  it("carries notices on a mutation result and defaults them when absent", () => {
    const withNotice = nativeMutationResultSchema.parse({
      ok: true,
      kind: "mcp",
      servers: [],
      notices: [NOTICE],
    });
    expect(
      withNotice.ok && withNotice.kind === "mcp" ? withNotice.notices : null,
    ).toEqual([NOTICE]);
    const without = nativeMutationResultSchema.parse({
      ok: true,
      kind: "mcp",
      servers: [row({})],
    });
    expect(
      without.ok && without.kind === "mcp" ? (without.notices ?? []) : null,
    ).toEqual([]);
  });

  it("strips notices and remedies from the pre-remedy list and mutation carriers", () => {
    const list = nativeListResultSchemaBeforeMcpRemedies.parse({
      ok: true,
      kind: "mcp",
      servers: [row({ remedy: REMEDY, enableConfirmation: ENABLE_REMEDY })],
      notices: [NOTICE],
    });
    expect(list).not.toHaveProperty("notices");
    expect(
      list.ok && list.kind === "mcp" ? list.servers[0] : null,
    ).not.toHaveProperty("remedy");

    const mutation = nativeMutationResultSchemaV10Preimage.parse({
      ok: true,
      kind: "mcp",
      servers: [row({ remedy: REMEDY })],
      notices: [NOTICE],
    });
    expect(mutation).not.toHaveProperty("notices");
    expect(
      mutation.ok && mutation.kind === "mcp" ? mutation.servers[0] : null,
    ).not.toHaveProperty("remedy");
  });
});

describe("applyRemedy action and capability", () => {
  const applyRemedy = {
    kind: "mcp",
    scope: "global",
    workspaceRoot: null,
    mutation: { action: "applyRemedy", remedyId: REMEDY.id },
  };

  it("the 1.1 and live 1.2 mutation requests spell applyRemedy; the released 1.0 request does not", () => {
    expect(nativeMutationSchema.safeParse(applyRemedy).success).toBe(true);
    expect(nativeMutationSchemaV10Preimage.safeParse(applyRemedy).success).toBe(
      false,
    );
    // 1.1 is frozen with no grant; the live 1.2 request carries one, null for
    // a mutation that installs nothing.
    expect(
      providersNativeMutateRequestSchemaV11.safeParse({
        providerId: "kimi",
        mutation: applyRemedy,
      }).success,
    ).toBe(true);
    expect(
      providersNativeMutateRequestSchema.safeParse({
        providerId: "kimi",
        mutation: applyRemedy,
        executableWriteGrant: null,
      }).success,
    ).toBe(true);
    expect(
      providersNativeMutateRequestSchemaV10Preimage.safeParse({
        providerId: "kimi",
        mutation: applyRemedy,
      }).success,
    ).toBe(false);
  });

  it("rejects an applyRemedy with an empty remedy id", () => {
    expect(
      nativeMutationSchema.safeParse({
        ...applyRemedy,
        mutation: { action: "applyRemedy", remedyId: "" },
      }).success,
    ).toBe(false);
  });

  it("still accepts every released mutation action on the 1.0 request", () => {
    const toggle = {
      kind: "mcp",
      scope: "global",
      workspaceRoot: null,
      mutation: { action: "toggleServer", name: "docs", enabled: true },
    };
    expect(nativeMutationSchemaV10Preimage.safeParse(toggle).success).toBe(
      true,
    );
    expect(nativeMutationSchema.safeParse(toggle).success).toBe(true);
  });

  it("defaults applyRemedy scopes to none when an old host omits them", () => {
    const parsed = providerMcpCapabilitiesSchema.safeParse(
      minimalCapabilities({}),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.actionScopes.applyRemedy ?? []).toEqual([]);
  });

  it("carries declared applyRemedy scopes", () => {
    const parsed = providerMcpCapabilitiesSchema.parse(
      minimalCapabilities({ applyRemedy: ["project"] }),
    );
    expect(parsed.actionScopes.applyRemedy).toEqual(["project"]);
  });

  it("keeps the released 10.0 capability descriptor free of applyRemedy", () => {
    const withRemedy = {
      ...nativeCapabilitiesBase(),
      mcp: minimalCapabilities({ applyRemedy: ["global"] }),
    };
    const released =
      providerNativeCapabilitiesSchemaBeforeMcpRemedies.parse(withRemedy);
    expect(released.mcp?.actionScopes).not.toHaveProperty("applyRemedy");
    const live = providerNativeCapabilitiesSchema.parse(withRemedy);
    expect(live.mcp?.actionScopes.applyRemedy).toEqual(["global"]);
  });
});

function nativeCapabilitiesBase(): Record<string, unknown> {
  return { ...DEFAULT_PROVIDER_NATIVE_CAPABILITIES };
}

function minimalCapabilities(
  extraScopes: Record<string, unknown>,
): Record<string, unknown> {
  return {
    transports: ["stdio", "http"],
    authTypes: ["none"],
    authActions: [],
    actionScopes: { ...NATIVE_MCP_SCOPES, ...extraScopes },
    addServer: "cli",
    removeServer: "cli",
    updateServer: "patch",
    perToolBacking: "native",
    statusSource: "probe",
    toolsSource: "probe",
    schemasSource: "probe",
    instructionsSource: "probe",
    traycerSessionsOnlyEnforcement: false,
    stdioDegradeNotice: false,
    oauthDegradesToConfigOnly: true,
  };
}
