import { describe, expect, it } from "vitest";

import { downgradeResponseAcrossMajors } from "@traycer/protocol/framework/index";
import { providersListResponseSchema } from "@traycer/protocol/host/provider-schemas";

import {
  providersListV70,
  providersListV90,
  providersListV91,
  providersListV92,
  providersListV100,
  providersListV101,
  providersListV102,
  providersListV103,
  providersNativeMutateV10,
  providersNativeMutateV11,
  providersNativeMutateV12,
  hostRpcRegistry,
} from "@traycer/protocol/host/registry";
import { providerNativeErrorCodeSchema } from "@traycer/protocol/host/provider-native-schemas";

/**
 * KiloCode native MCP carriers (design: kilocode-native-mcp-support, mutation
 * delivery A36-A38, A44). `origin`, `coverage`, `decidedBy` and the codes
 * `server_not_found` / `change_shadowed` exist only on list@10.3 and
 * nativeMutate@1.2. Every earlier line keeps the shape it shipped: the field
 * is stripped and the new code is rejected, so a released reader never sees
 * something it cannot spell.
 */

const ORIGIN = {
  scope: "project",
  label: "Project settings",
  path: null,
  inherited: false,
  editable: true,
};
const DECIDED_BY = {
  pattern: "docs_*",
  action: "deny",
  label: "opencode.jsonc",
  path: null,
};
const COVERAGE = {
  complete: false,
  sources: [
    {
      label: "Managed settings",
      path: null,
      scope: "managed",
      outcome: "unsupported",
      reason: "Not readable here.",
    },
  ],
};

function tool(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "search",
    description: null,
    inputSchema: null,
    enabled: true,
    readOnly: false,
    ...overrides,
  };
}

function server(
  toolOverrides: Record<string, unknown>,
  origin: Record<string, unknown> | undefined,
) {
  return {
    name: "docs",
    enabled: true,
    transport: { type: "http", url: "https://example.com/mcp", auth: null },
    status: "connected",
    statusSource: "probe",
    statusDetail: null,
    tools: [tool(toolOverrides)],
    discoveryPending: false,
    instructions: null,
    configOnly: false,
    stdioDegraded: false,
    ...(origin === undefined ? {} : { origin }),
  };
}

function listMcp(toolOverrides: Record<string, unknown>) {
  return {
    providers: [],
    native: {
      ok: true,
      kind: "mcp",
      servers: [server(toolOverrides, ORIGIN)],
      notices: [],
      coverage: COVERAGE,
    },
  };
}

function listDiscover(toolOverrides: Record<string, unknown>) {
  return {
    providers: [],
    native: {
      ok: true,
      kind: "mcpDiscover",
      server: server(toolOverrides, ORIGIN),
    },
  };
}

function mutateMcp(toolOverrides: Record<string, unknown>) {
  return {
    result: {
      ok: true,
      kind: "mcp",
      servers: [server(toolOverrides, ORIGIN)],
      notices: [],
      coverage: COVERAGE,
    },
  };
}

const OLD_LIST_LINES = [
  ["7.0", providersListV70],
  ["9.0", providersListV90],
  ["9.1", providersListV91],
  ["9.2", providersListV92],
  ["10.0", providersListV100],
  ["10.1", providersListV101],
  ["10.2", providersListV102],
] as const;

const OLD_MUTATE_LINES = [
  ["1.0", providersNativeMutateV10],
  ["1.1", providersNativeMutateV11],
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstOf(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) throw new Error("expected an array");
  const first: unknown = value[0];
  if (!isRecord(first)) throw new Error("expected a record");
  return first;
}

function firstServer(native: unknown): Record<string, unknown> {
  if (!isRecord(native)) throw new Error("expected a native record");
  const direct = native["server"];
  if (isRecord(direct)) return direct;
  return firstOf(native["servers"]);
}

function firstTool(row: Record<string, unknown>): Record<string, unknown> {
  return firstOf(row["tools"]);
}

describe("list@10.3 carries origin, coverage and decidedBy", () => {
  it("keeps all three on the mcp arm", () => {
    const parsed = providersListV103.responseSchema.parse(
      listMcp({ decidedBy: DECIDED_BY }),
    );
    const native = parsed.native;
    expect(native).toMatchObject({ kind: "mcp", coverage: COVERAGE });
    const row = firstServer(native);
    expect(row["origin"]).toEqual(ORIGIN);
    expect(firstTool(row)["decidedBy"]).toEqual(DECIDED_BY);
  });

  it("keeps all three on the mcpDiscover arm", () => {
    const parsed = providersListV103.responseSchema.parse(
      listDiscover({ decidedBy: DECIDED_BY }),
    );
    const row = firstServer(parsed.native);
    expect(row["origin"]).toEqual(ORIGIN);
    expect(firstTool(row)["decidedBy"]).toEqual(DECIDED_BY);
  });

  it("accepts a tool with no matching rule as decidedBy null (A44)", () => {
    const withNull = providersListV103.responseSchema.parse(
      listMcp({ decidedBy: null }),
    );
    expect(firstTool(firstServer(withNull.native))["decidedBy"]).toBeNull();
    const discoverNull = providersListV103.responseSchema.parse(
      listDiscover({ decidedBy: null }),
    );
    expect(firstTool(firstServer(discoverNull.native))["decidedBy"]).toBeNull();
  });

  it("reads an absent decidedBy, origin and coverage as null (old host)", () => {
    const bare = server({}, undefined);
    const parsed = providersListV103.responseSchema.parse({
      providers: [],
      native: { ok: true, kind: "mcp", servers: [bare] },
    });
    const native = parsed.native;
    expect(native).toMatchObject({ kind: "mcp", coverage: null });
    const row = firstServer(native);
    expect(row["origin"] ?? null).toBeNull();
    expect(firstTool(row)["decidedBy"] ?? null).toBeNull();
  });

  it("rejects a malformed origin scope and an unknown coverage outcome", () => {
    const badOrigin = {
      providers: [],
      native: {
        ok: true,
        kind: "mcp",
        servers: [server({}, { ...ORIGIN, scope: "nowhere" })],
      },
    };
    expect(providersListV103.responseSchema.safeParse(badOrigin).success).toBe(
      false,
    );
    const badCoverage = {
      ...listMcp({}),
      native: {
        ...listMcp({}).native,
        coverage: {
          complete: true,
          sources: [{ ...COVERAGE.sources[0], outcome: "mystery" }],
        },
      },
    };
    expect(
      providersListV103.responseSchema.safeParse(badCoverage).success,
    ).toBe(false);
  });
});

describe("released list lines strip the new fields (A44)", () => {
  for (const [label, contract] of OLD_LIST_LINES) {
    it(`list@${label} drops origin, coverage and decidedBy`, () => {
      for (const body of [
        listMcp({ decidedBy: DECIDED_BY }),
        listMcp({ decidedBy: null }),
        listDiscover({ decidedBy: DECIDED_BY }),
      ]) {
        const parsed = contract.responseSchema.parse(body);
        const native: unknown = parsed.native;
        expect(isRecord(native)).toBe(true);
        expect(native).not.toHaveProperty("coverage");
        const row = firstServer(native);
        expect(row).not.toHaveProperty("origin");
        expect(firstTool(row)).not.toHaveProperty("decidedBy");
      }
    });
  }
});

describe("nativeMutate@1.2 carries the new fields; 1.0 and 1.1 strip them", () => {
  it("keeps origin, coverage and decidedBy (null and set) on 1.2", () => {
    for (const decidedBy of [DECIDED_BY, null]) {
      const parsed = providersNativeMutateV12.responseSchema.parse(
        mutateMcp({ decidedBy }),
      );
      expect(parsed.result).toMatchObject({ kind: "mcp", coverage: COVERAGE });
      const row = firstServer(parsed.result);
      expect(row["origin"]).toEqual(ORIGIN);
      expect(firstTool(row)["decidedBy"]).toEqual(decidedBy);
    }
  });

  for (const [label, contract] of OLD_MUTATE_LINES) {
    it(`nativeMutate@${label} drops them`, () => {
      const parsed = contract.responseSchema.parse(
        mutateMcp({ decidedBy: DECIDED_BY }),
      );
      expect(parsed.result).not.toHaveProperty("coverage");
      const row = firstServer(parsed.result);
      expect(row).not.toHaveProperty("origin");
      expect(firstTool(row)).not.toHaveProperty("decidedBy");
    });
  }
});

describe("new error codes exist only on list@10.3 and nativeMutate@1.2 (A37)", () => {
  const NEW_CODES = ["server_not_found", "change_shadowed"] as const;

  it("the live enum includes both", () => {
    for (const code of NEW_CODES) {
      expect(providerNativeErrorCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it("10.3 and 1.2 accept them as typed refusals", () => {
    for (const code of NEW_CODES) {
      const refusal = { ok: false, code, detail: "Not changed." };
      expect(
        providersListV103.responseSchema.safeParse({
          providers: [],
          native: refusal,
        }).success,
      ).toBe(true);
      expect(
        providersNativeMutateV12.responseSchema.safeParse({ result: refusal })
          .success,
      ).toBe(true);
    }
  });

  it("every earlier list and mutate line rejects them", () => {
    for (const code of NEW_CODES) {
      const refusal = { ok: false, code, detail: null };
      for (const [label, contract] of OLD_LIST_LINES) {
        expect(
          contract.responseSchema.safeParse({ providers: [], native: refusal })
            .success,
          `list@${label} must reject ${code}`,
        ).toBe(false);
      }
      for (const [label, contract] of OLD_MUTATE_LINES) {
        expect(
          contract.responseSchema.safeParse({ result: refusal }).success,
          `nativeMutate@${label} must reject ${code}`,
        ).toBe(false);
      }
    }
  });

  it("earlier lines still accept every code they shipped", () => {
    const refusal = { ok: false, code: "unsupported_action", detail: "x" };
    for (const [, contract] of OLD_LIST_LINES) {
      expect(
        contract.responseSchema.safeParse({ providers: [], native: refusal })
          .success,
      ).toBe(true);
    }
    for (const [, contract] of OLD_MUTATE_LINES) {
      expect(
        contract.responseSchema.safeParse({ result: refusal }).success,
      ).toBe(true);
    }
  });
});

describe("list@10.3 -> 9.2 / 8.0 / 7.0 bridges map the new codes (A38)", () => {
  const TARGET_MAJORS = [9, 8, 7] as const;

  function downgradeNative(
    major: (typeof TARGET_MAJORS)[number],
    native: unknown,
  ): unknown {
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      10,
      major,
      providersListResponseSchema.parse({ providers: [], native }),
    );
    expect(downgraded.ok).toBe(true);
    return downgraded.ok ? downgraded.value.native : undefined;
  }

  for (const major of TARGET_MAJORS) {
    for (const code of ["server_not_found", "change_shadowed"] as const) {
      it(`${code} reaches a v${major} caller as unsupported_action with its detail`, () => {
        expect(
          downgradeNative(major, { ok: false, code, detail: "Not changed." }),
        ).toEqual({
          ok: false,
          code: "unsupported_action",
          detail: "Not changed.",
        });
      });
    }

    it(`v${major}: an old code and a success pass through unchanged`, () => {
      const oldCode = { ok: false, code: "duplicate_name", detail: "x" };
      expect(downgradeNative(major, oldCode)).toEqual(oldCode);
      const success = downgradeNative(major, {
        ok: true,
        kind: "mcp",
        servers: [],
        notices: [],
      });
      expect(success).toMatchObject({ ok: true, kind: "mcp", servers: [] });
    });
  }
});
