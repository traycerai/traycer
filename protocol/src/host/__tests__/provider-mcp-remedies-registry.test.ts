import { describe, expect, it } from "vitest";

import {
  providersListResponseSchema,
  providersListResponseSchemaV100Preimage,
  providersListResponseSchemaV101Preimage,
  providersListResponseSchemaV92,
} from "@traycer/protocol/host/provider-schemas";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * Registry half of `provider-mcp-remedies-compat.test.ts`: kept apart because
 * loading the registry validates every line's minors, so a registry mistake
 * must not hide the pure-schema cases in the sibling file.
 */

const REMEDY = {
  id: "trust-workspace",
  label: "Trust this folder",
  confirmation: "Kimi will run this folder's MCP servers on this machine.",
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

describe("registry lines", () => {
  const listMajor10 = hostRpcRegistry["providers.list"][10];
  const mutateMajor1 = hostRpcRegistry["providers.nativeMutate"][1];

  it("opens providers.list@10.1 and nativeMutate@1.1 with upgrade paths from the released minors", () => {
    // The released 10.1 minor stays registered with its bridge; later minors
    // (10.2 opened for `macosRequirement`, then 10.3 for MCP origin) may sit above it.
    expect(listMajor10.versions[1].contract.schemaVersion).toEqual({
      major: 10,
      minor: 1,
    });
    expect(listMajor10.versions[1].upgradeFromPreviousVersion).not.toBeNull();
    expect(mutateMajor1.versions[1].contract.schemaVersion).toEqual({
      major: 1,
      minor: 1,
    });
    expect(mutateMajor1.versions[1].upgradeFromPreviousVersion).not.toBeNull();
  });

  it("freezes list@10.0 and mutate@1.0 at the pre-remedy shape", () => {
    const list10 = listMajor10.versions[0].contract.responseSchema;
    const payload = {
      providers: [],
      native: { ok: true, kind: "mcp", servers: [row({})], notices: [NOTICE] },
    };
    const parsed100 = list10.parse(payload);
    expect(parsed100.native).not.toHaveProperty("notices");
    const parsed101 = providersListResponseSchemaV101Preimage.parse(payload);
    expect(
      parsed101.native?.ok && parsed101.native.kind === "mcp"
        ? parsed101.native.notices
        : null,
    ).toEqual([NOTICE]);

    const mutate10 = mutateMajor1.versions[0].contract;
    expect(
      mutate10.requestSchema.safeParse({
        providerId: "kimi",
        mutation: {
          kind: "mcp",
          scope: "global",
          workspaceRoot: null,
          mutation: { action: "applyRemedy", remedyId: REMEDY.id },
        },
      }).success,
    ).toBe(false);
  });

  it("every provider-state response before 10.1 strips MCP notices", () => {
    const payload = {
      providers: [],
      native: { ok: true, kind: "mcp", servers: [row({})], notices: [NOTICE] },
    };
    for (const schema of [
      providersListResponseSchemaV100Preimage,
      providersListResponseSchemaV92,
    ]) {
      expect(schema.parse(payload).native).not.toHaveProperty("notices");
    }
  });

  it("a 10.1 reader accepts an old host's list@10.0-shaped body", () => {
    const parsed = providersListResponseSchema.parse({
      providers: [],
      native: { ok: true, kind: "mcp", servers: [row({})] },
    });
    expect(parsed.native?.ok).toBe(true);
  });
});
