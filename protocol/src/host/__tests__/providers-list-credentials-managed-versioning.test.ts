import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  providersListV104,
  providersListV105,
  providersListV106,
} from "@traycer/protocol/host/registry";
import {
  providersListResponseSchema,
  providersListResponseSchemaV104Preimage,
  providersListResponseSchemaV105Preimage,
} from "@traycer/protocol/host/provider-schemas";

/**
 * `providers.list@10.5`: the envelope's `credentialsManagedInAccount`, true on
 * a sandbox host. A new KEY, so the frozen 10.4 response strips it on the
 * within-major re-parse.
 */

describe("providers.list@10.5 registry binding", () => {
  it("opens 10.5 above a frozen 10.4", () => {
    const line = hostRpcRegistry["providers.list"][10];
    expect(line.versions[4].contract).toBe(providersListV104);
    expect(line.versions[5].contract).toBe(providersListV105);
    expect(providersListV105.responseSchema).toBe(
      providersListResponseSchemaV105Preimage,
    );
    expect(providersListV104.responseSchema).toBe(
      providersListResponseSchemaV104Preimage,
    );
  });
});

describe("providers.list live response", () => {
  it.each([true, false])("keeps credentialsManagedInAccount %s", (flag) => {
    const parsed = providersListResponseSchema.parse({
      providers: [],
      credentialsManagedInAccount: flag,
    });
    expect(parsed.credentialsManagedInAccount).toBe(flag);
  });

  it("parses a response without the key and leaves it absent", () => {
    const parsed = providersListResponseSchema.parse({ providers: [] });
    expect(parsed.providers).toEqual([]);
    expect(parsed.credentialsManagedInAccount).toBeUndefined();
  });
});

describe("providers.list frozen 10.4 response", () => {
  it.each([true, false])("strips credentialsManagedInAccount %s", (flag) => {
    const parsed = providersListResponseSchemaV104Preimage.parse({
      providers: [],
      credentialsManagedInAccount: flag,
    });
    expect(Object.hasOwn(parsed, "credentialsManagedInAccount")).toBe(false);
    expect(parsed.providers).toEqual([]);
  });
});

const managedLine = {
  line: 1,
  candidate: {
    kind: "bundled",
    path: "",
    version: null,
    available: true,
    versionPending: false,
  },
  packId: "opencode",
  managedInstallState: null,
  managedVersions: null,
  managedVersionsUnavailable: null,
};

function opencodeRow(extra: Record<string, unknown>) {
  return {
    providerId: "opencode",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled", line: 1 },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
    },
    ...extra,
  };
}

describe("providers.list@10.6 managedLines and selected.line", () => {
  const payload = {
    providers: [
      opencodeRow({
        managedLines: [managedLine, { ...managedLine, line: 2 }],
      }),
    ],
  };

  it("registers 10.6 over the 10.5 preimage", () => {
    const line = hostRpcRegistry["providers.list"][10];
    expect(line.versions[6].contract).toBe(providersListV106);
    expect(line.versions[5].contract).toBe(providersListV105);
  });

  it("keeps managedLines and selected.line at 10.6", () => {
    const row = providersListV106.responseSchema.parse(payload).providers[0];
    expect(row?.managedLines?.map((entry) => entry.line)).toEqual([1, 2]);
    expect(row?.selected).toEqual({ kind: "bundled", line: 1 });
  });

  it("strips both at the 10.5 re-parse", () => {
    const row = providersListV105.responseSchema.parse(payload).providers[0];
    expect(row !== undefined && Object.hasOwn(row, "managedLines")).toBe(false);
    expect(row?.selected).toEqual({ kind: "bundled" });
  });

  it("refuses a managed line whose candidate is not the bundled one", () => {
    const row = providersListV106.responseSchema.parse({
      providers: [
        opencodeRow({
          managedLines: [
            {
              ...managedLine,
              candidate: { ...managedLine.candidate, kind: "path" },
            },
          ],
        }),
      ],
    }).providers[0];
    expect(row?.managedLines).toEqual([]);
  });

  it("reads a malformed managedLines as empty", () => {
    const row = providersListV106.responseSchema.parse({
      providers: [opencodeRow({ managedLines: "nope" })],
    }).providers[0];
    expect(row?.managedLines).toEqual([]);
  });
});
