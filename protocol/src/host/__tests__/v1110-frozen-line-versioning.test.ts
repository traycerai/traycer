/**
 * Both-direction bridge coverage for the lines `host-v1.1.10` froze without
 * the fields that had been riding them (`epic.createTuiAgent@1.0` without
 * `forkSourceHarnessSessionId`, `providers.list@4.0/5.0/6.0` requests without
 * `native` - the release cherry-pick dropped the commits that added them).
 *
 * Drives the real registries through the same traversal helpers the host
 * handler (`upgradeRequestToVersion` / `downgradeResponseAcrossMajors`) and
 * the client transport (zod-strip on the older minor's request schema,
 * `downgradeRequestAcrossMajors`) execute at runtime, so a transform that
 * drops or leaks one of these fields fails here, not against a released peer.
 */
import { describe, expect, it } from "vitest";
import {
  downgradeRequestAcrossMajors,
  downgradeResponseAcrossMajors,
  upgradeRequestToVersion,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/versioned-rpc";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  createTuiAgentRequestSchemaV10,
  createTuiAgentRequestSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  providersListRequestSchema,
  providersListRequestSchemaBeforeV70,
  providersListRequestSchemaV70,
  providersListResponseSchema,
  providersListResponseSchemaV60,
} from "@traycer/protocol/host/provider-schemas";
import type { NativeListQueryV70 } from "@traycer/protocol/host/provider-native-schemas";

const createTuiRegistry = hostRpcRegistry["epic.createTuiAgent"];
const providersListRegistry = hostRpcRegistry["providers.list"];

const canonicalCreateRequest = createTuiAgentRequestSchema.parse({
  epicId: "e1",
  parentId: null,
  title: "t",
  harnessId: "claude",
  harnessSessionId: "sess-1",
  terminalShellCommand: null,
  terminalShellArgs: null,
  hostId: "h1",
  workspaceFolders: ["/w"],
  model: null,
  agentMode: "regular",
  forkSourceHarnessSessionId: "fork-src-1",
});

describe("epic.createTuiAgent 1.0 <-> 1.1", () => {
  it("released 1.0 client -> new host: V10 parse accepts the released shape, chain fills null", () => {
    // Exactly what a released v1.1.10 client sends (no fork field).
    const released = {
      epicId: "e1",
      parentId: null,
      title: "t",
      harnessId: "claude",
      harnessSessionId: null,
      terminalShellCommand: null,
      terminalShellArgs: null,
      hostId: "h1",
      workspaceFolders: ["/w"],
      model: null,
      agentMode: "regular",
    };
    const parsed = createTuiAgentRequestSchemaV10.parse(released);
    const canonical = upgradeRequestToVersion(
      createTuiRegistry,
      { major: 1, minor: 0 },
      { major: 1, minor: 1 },
      parsed,
    );
    expect(canonical.forkSourceHarnessSessionId).toBeNull();
    expect(() => createTuiAgentRequestSchema.parse(canonical)).not.toThrow();
    // Host response leg back to the 1.0 caller: same-major identity + strip.
    const response = { tuiAgentId: "a1" };
    const up = upgradeResponseToVersion(
      createTuiRegistry,
      { major: 1, minor: 0 },
      { major: 1, minor: 1 },
      response,
    );
    expect(up).toEqual(response);
  });

  it("new 1.1 client -> released 1.0 host: transport zod-strip projects the fork field away", () => {
    // Mirrors prepareRequestPayload's same-major newer-client branch.
    const stripped = createTuiAgentRequestSchemaV10.safeParse(
      canonicalCreateRequest,
    );
    expect(stripped.success).toBe(true);
    if (!stripped.success) return;
    expect(stripped.data).not.toHaveProperty("forkSourceHarnessSessionId");
    // Everything the released host's schema models survives projection.
    expect(stripped.data.harnessSessionId).toBe("sess-1");
    expect(stripped.data.profileId).toBeNull();
  });
});

const frozenProvidersRequest = { forceAuthRefresh: true };

// v7.0 is now a frozen line of its own, and its request is the FIRST that
// models `native` - so it cannot share the pre-v7.0 schema or the pre-v7.0
// expectations. The loops below select both per major rather than stopping at
// 6, which would have left the newest frozen request line untested.
//
// "Frozen", not "released": majors 1-6 are both, but v7.0 is frozen at the
// v8.0 integration cut and has not shipped in a non-RC release yet. The bridge
// coverage is identical either way - a frozen line's bridges have to be right
// before the release that makes them load-bearing, not after.
const OLDER_REQUEST_MAJORS = [1, 2, 3, 4, 5, 6] as const;
const ALL_FROZEN_REQUEST_MAJORS = [1, 2, 3, 4, 5, 6, 7] as const;

function frozenRequestSchemaFor(major: number) {
  return major >= 7
    ? providersListRequestSchemaV70
    : providersListRequestSchemaBeforeV70;
}

describe("providers.list request lines 1.0..7.0 <-> latest", () => {
  it("frozen callers at every major upgrade to canonical with native:null", () => {
    for (const major of ALL_FROZEN_REQUEST_MAJORS) {
      const parsed = frozenRequestSchemaFor(major).parse(
        frozenProvidersRequest,
      );
      const canonical = upgradeRequestToVersion(
        providersListRegistry,
        { major, minor: 0 },
        { major: 8, minor: 0 },
        parsed,
      );
      // Same expectation at every major, reached two different ways: below
      // v7.0 the v6→v7 bridge FILLS `native: null`; at v7.0 the request
      // already models it and the field's own default supplies it.
      expect(canonical, `major ${major}`).toEqual({
        forceAuthRefresh: true,
        native: null,
      });
      expect(() => providersListRequestSchema.parse(canonical)).not.toThrow();
    }
  });

  it("a new latest-major client downgrades its request to every older frozen major without leaking native", () => {
    const canonical = providersListRequestSchema.parse({
      forceAuthRefresh: true,
      native: {
        kind: "mcp",
        providerId: "claude-code",
        scope: "global",
        workspaceRoot: null,
      },
    });
    for (const major of OLDER_REQUEST_MAJORS) {
      const down = downgradeRequestAcrossMajors(
        providersListRegistry,
        8,
        major,
        canonical,
      );
      expect(down.ok, `major ${major}`).toBe(true);
      if (!down.ok) continue;
      expect(down.value, `major ${major}`).not.toHaveProperty("native");
      expect(
        providersListRequestSchemaBeforeV70.safeParse(down.value).success,
        `major ${major} reparse`,
      ).toBe(true);
    }
  });

  // One payload per arm of the frozen v7.0 query union, keyed BY DISCRIMINANT
  // so the type system owns the coverage: `Record<NativeListQueryV70["kind"],
  // …>` does not compile until every arm has an entry, so a sixth arm added to
  // the union fails here rather than quietly going untested.
  //
  // The arms are not interchangeable, which is the point. `mcp`/`plugins`/
  // `skills` carry only the scope tuple, but `mcpDiscover` adds
  // `serverName`/`forceRefresh` and `pluginIcon` adds `pluginId`/`theme` - a
  // downgrade that reshaped the union could drop those and still look correct
  // against an `mcp`-only assertion.
  const V70_QUERY_CASES: {
    // Mapped over the discriminant with `Extract`, not `Record<kind, union>`:
    // the latter accepts ANY arm under ANY key, so a payload filed under the
    // wrong `kind` would type-check and quietly test one arm twice while
    // reporting the other's name.
    [K in NativeListQueryV70["kind"]]: Extract<NativeListQueryV70, { kind: K }>;
  } = {
    mcp: {
      kind: "mcp",
      providerId: "claude-code",
      scope: "global",
      workspaceRoot: null,
    },
    plugins: {
      kind: "plugins",
      providerId: "codex",
      scope: "global",
      workspaceRoot: null,
    },
    skills: {
      kind: "skills",
      providerId: "opencode",
      scope: "global",
      workspaceRoot: null,
    },
    // Project-scoped on purpose: carries the extra discovery fields AND the
    // scope/workspaceRoot invariant across the hop.
    mcpDiscover: {
      kind: "mcpDiscover",
      providerId: "amp",
      scope: "project",
      workspaceRoot: "/w",
      serverName: "some-server",
      forceRefresh: true,
    },
    pluginIcon: {
      kind: "pluginIcon",
      providerId: "codex",
      scope: "global",
      workspaceRoot: null,
      pluginId: "pdf",
      theme: "dark",
    },
  };

  it.each(Object.entries(V70_QUERY_CASES))(
    "keeps a %s native query intact on the 8.0 -> 7.0 request hop",
    (_kind, native) => {
      // The inverse of the strip assertion above, and the reason that loop
      // stops at 6: v7.0 is the one older line whose request models `native`,
      // so stripping here would silently drop a v7.0 caller's list query.
      const canonical = providersListRequestSchema.parse({
        forceAuthRefresh: true,
        native,
      });
      const down = downgradeRequestAcrossMajors(
        providersListRegistry,
        8,
        7,
        canonical,
      );
      expect(down.ok).toBe(true);
      if (!down.ok) return;
      // Deep-equal against the ORIGINAL payload, not against a re-parse of the
      // result: a dropped `serverName` would survive a reparse (the field is
      // required, so it would fail - but a dropped `forceRefresh` or a
      // defaulted one would not) and the round-trip has to be lossless, not
      // merely valid.
      expect(down.value.native).toEqual(native);
      expect(
        providersListRequestSchemaV70.safeParse(down.value).success,
      ).toBe(true);
    },
  );

  it("response round-trip 8.0 -> 6.0 -> 8.0 still parses at both ends", () => {
    const canonicalResponse = providersListResponseSchema.parse({
      providers: [],
      native: null,
    });
    const down = downgradeResponseAcrossMajors(
      providersListRegistry,
      8,
      6,
      canonicalResponse,
    );
    expect(down.ok).toBe(true);
    if (!down.ok) return;
    expect(down.value).not.toHaveProperty("native");
    expect(providersListResponseSchemaV60.safeParse(down.value).success).toBe(
      true,
    );
    const back = upgradeResponseToVersion(
      providersListRegistry,
      { major: 6, minor: 0 },
      { major: 8, minor: 0 },
      providersListResponseSchemaV60.parse(down.value),
    );
    expect(back.native).toBeNull();
    expect(providersListResponseSchema.safeParse(back).success).toBe(true);
  });
});
