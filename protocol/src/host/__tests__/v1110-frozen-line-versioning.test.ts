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
  providersListRequestSchemaBeforeV70,
  providersListRequestSchemaV70,
  providersListResponseSchemaV60,
  providersListResponseSchemaV70,
} from "@traycer/protocol/host/provider-schemas";
import type { NativeListQuery } from "@traycer/protocol/host/provider-native-schemas";

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

const releasedProvidersRequest = { forceAuthRefresh: true };

// v7.0 is the newest line and the only one whose request models `native`, so
// it cannot share the pre-v7.0 schema or the pre-v7.0 expectations. Majors 1-6
// are the ones with peers in the field; v7.0 has none yet (no non-RC tag
// carries a major-7 contract), which is why nothing downgrades INTO it and the
// strip loop stops at 6.
//
// Its request is read here through `providersListRequestSchemaV70` - the
// inactive pin, held identical to the live schema by the equality guard in
// `provider-model-providers-compat.test.ts`. Reading the pin rather than the
// live schema is the point: the day this line is released, the pin becomes the
// contract, so it is the shape worth asserting against now.
const RELEASED_REQUEST_MAJORS = [1, 2, 3, 4, 5, 6] as const;
const ALL_REQUEST_MAJORS = [1, 2, 3, 4, 5, 6, 7] as const;

function requestSchemaFor(major: number) {
  return major >= 7
    ? providersListRequestSchemaV70
    : providersListRequestSchemaBeforeV70;
}

describe("providers.list request lines 1.0..6.0 <-> 7.0", () => {
  it("callers at every major upgrade to canonical with native:null", () => {
    for (const major of ALL_REQUEST_MAJORS) {
      const parsed = requestSchemaFor(major).parse(releasedProvidersRequest);
      const canonical = upgradeRequestToVersion(
        providersListRegistry,
        { major, minor: 0 },
        { major: 7, minor: 0 },
        parsed,
      );
      // Same expectation at every major, reached two different ways: below
      // v7.0 the v6→v7 bridge FILLS `native: null`; at v7.0 the request
      // already models it and the field's own default supplies it.
      expect(canonical, `major ${major}`).toEqual({
        forceAuthRefresh: true,
        native: null,
      });
      // Asserted against the frozen v7.0 schema specifically, not merely the
      // canonical one - the registered `providers.list` v7.0 contract is
      // pinned to `providersListRequestSchemaV70`, so this is the schema a
      // real peer negotiating v7.0 actually decodes against.
      expect(() =>
        providersListRequestSchemaV70.parse(canonical),
      ).not.toThrow();
    }
  });

  it("a new 7.0 client downgrades its request to every released major without leaking native", () => {
    const canonical = providersListRequestSchemaV70.parse({
      forceAuthRefresh: true,
      native: {
        kind: "mcp",
        providerId: "claude-code",
        scope: "global",
        workspaceRoot: null,
      },
    });
    for (const major of RELEASED_REQUEST_MAJORS) {
      const down = downgradeRequestAcrossMajors(
        providersListRegistry,
        7,
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
  // so the type system owns the coverage: `Record<NativeListQuery["kind"],
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
    [K in NativeListQuery["kind"]]: Extract<NativeListQuery, { kind: K }>;
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
    "the inactive v7.0 request pin round-trips a %s native query losslessly",
    (_kind, native) => {
      // NOT a bridge test. The registered v7.0 contract decodes requests
      // through this pin, and its `native` deliberately stays the live query
      // schema (see the pin's comment) - so what has to hold is that the pin
      // carries every arm losslessly; an arm it mangles mangles real traffic.
      const canonical = providersListRequestSchemaV70.parse({
        forceAuthRefresh: true,
        native,
      });
      const pinned = providersListRequestSchemaV70.safeParse(canonical);
      expect(pinned.success).toBe(true);
      if (!pinned.success) return;
      // Deep-equal against the ORIGINAL payload, not merely "it parsed": a
      // dropped `serverName` would fail a reparse (it is required), but a
      // dropped or defaulted `forceRefresh` would not - and the pin has to be
      // lossless, not just valid.
      expect(pinned.data.native).toEqual(native);
    },
  );

  it("response round-trip 7.0 -> 6.0 -> 7.0 still parses at both ends", () => {
    const canonicalResponse = providersListResponseSchemaV70.parse({
      providers: [],
      native: null,
    });
    const down = downgradeResponseAcrossMajors(
      providersListRegistry,
      7,
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
      { major: 7, minor: 0 },
      providersListResponseSchemaV60.parse(down.value),
    );
    expect(back.native).toBeNull();
    expect(providersListResponseSchemaV70.safeParse(back).success).toBe(true);
  });
});
