import { describe, expect, it } from "vitest";
import { RPC_ERROR_CODES } from "@traycer/protocol/framework/versioned-rpc-types";
import {
  SANDBOX_HEARTBEAT_PHASES,
  parseSandboxHeartbeatPhase,
  sandboxCostSchema,
  sandboxListResponseSchema,
  sandboxRouteReadinessSchema,
  sandboxSummarySchema,
  userSandboxCostSchema,
  type SandboxRouteState,
} from "@traycer/protocol/host/sandbox-control";

/**
 * The summary's `phase` and `routes`: the wake phase a sandbox host last
 * reported and each brokered route's readiness. Both ride the tolerant sandbox
 * row, so an older server's body (neither key) reads as two nulls.
 */
const SANDBOX_VIEW = {
  id: "sbx_1",
  hostId: "8f6f2d7e-1f43-4c1e-9d63-1e3a7d2c9b10",
  kind: "agent",
  provider: "tensorlake",
  region: "us-east",
  os: "linux",
  cpus: 2,
  memoryMb: 4096,
  diskMb: 20480,
  displayName: "build-box",
  state: "awake",
  frozen: false,
  failureCode: null,
  idleMinutes: null,
  burst: false,
  createdByHostId: null,
  createdByAgentId: null,
  createdAt: 1_791_000_000_000,
  lastTransitionAt: 1_791_000_010_000,
  lastActivityAt: null,
  destroyedAt: null,
  priceMcPerHour: { awakeMc: 120, suspendedMc: 4, stoppedMc: 2 },
};

describe("parseSandboxHeartbeatPhase", () => {
  it.each(SANDBOX_HEARTBEAT_PHASES)("names the %s phase", (name) => {
    expect(parseSandboxHeartbeatPhase(name)).toEqual({ kind: name });
  });

  it("lists the five phases in wake order", () => {
    expect(SANDBOX_HEARTBEAT_PHASES).toEqual([
      "enrolling",
      "proving",
      "attaching",
      "proxy-reachable",
      "ready",
    ]);
  });

  it("reads degraded(gateway) as a degraded phase naming the hop", () => {
    expect(parseSandboxHeartbeatPhase("degraded(gateway)")).toEqual({
      kind: "degraded",
      hop: "gateway",
    });
  });

  it("reads degraded() as a degraded phase with an empty hop", () => {
    expect(parseSandboxHeartbeatPhase("degraded()")).toEqual({
      kind: "degraded",
      hop: "",
    });
  });

  it("keeps a nested paren inside the hop", () => {
    expect(parseSandboxHeartbeatPhase("degraded(a(b))")).toEqual({
      kind: "degraded",
      hop: "a(b)",
    });
  });

  it.each([
    "warming",
    "",
    "Ready",
    "ready ",
    "degraded",
    "degraded(gateway",
    "xdegraded(gateway)",
    "degraded(gateway)x",
  ])("reads %j as an unknown phase, never as ready", (raw) => {
    expect(parseSandboxHeartbeatPhase(raw)).toEqual({ kind: "unknown", raw });
  });
});

describe("sandbox summary phase and routes", () => {
  it("keeps phase proxy-reachable", () => {
    const parsed = sandboxSummarySchema.parse({
      ...SANDBOX_VIEW,
      phase: "proxy-reachable",
    });
    expect(parsed.phase).toBe("proxy-reachable");
  });

  it("keeps a phase string this build does not know", () => {
    const parsed = sandboxSummarySchema.parse({
      ...SANDBOX_VIEW,
      phase: "degraded(gateway)",
    });
    expect(parsed.phase).toBe("degraded(gateway)");
  });

  it.each<SandboxRouteState>(["pending", "ready", "unavailable"])(
    "keeps a %s route",
    (state) => {
      const code = state === "unavailable" ? "connector_offline" : null;
      const parsed = sandboxSummarySchema.parse({
        ...SANDBOX_VIEW,
        phase: "ready",
        routes: [{ route: "route-1", state, code }],
      });
      expect(parsed.routes).toEqual([{ route: "route-1", state, code }]);
    },
  );

  it("keeps several routes in order", () => {
    const parsed = sandboxSummarySchema.parse({
      ...SANDBOX_VIEW,
      routes: [
        { route: "route-1", state: "ready", code: null },
        { route: "route-2", state: "unavailable", code: "leaf_unavailable" },
      ],
    });
    expect(parsed.routes?.map((route) => route.route)).toEqual([
      "route-1",
      "route-2",
    ]);
  });

  it("reads a body without phase and routes as two nulls", () => {
    const parsed = sandboxSummarySchema.parse(SANDBOX_VIEW);
    expect(parsed.phase).toBeNull();
    expect(parsed.routes).toBeNull();
  });

  it("keeps explicit nulls as nulls", () => {
    const parsed = sandboxSummarySchema.parse({
      ...SANDBOX_VIEW,
      phase: null,
      routes: null,
    });
    expect(parsed.phase).toBeNull();
    expect(parsed.routes).toBeNull();
  });

  it("keeps an empty routes array distinct from null", () => {
    const parsed = sandboxSummarySchema.parse({ ...SANDBOX_VIEW, routes: [] });
    expect(parsed.routes).toEqual([]);
  });

  it("defaults a route's missing code to null", () => {
    const parsed = sandboxRouteReadinessSchema.parse({
      route: "route-1",
      state: "pending",
    });
    expect(parsed.code).toBeNull();
  });

  it("reads routes as null when one route's state is newer than this build, and keeps the row and the list", () => {
    const unreadable = [
      { route: "route-1", state: "ready", code: null },
      { route: "route-2", state: "draining", code: null },
    ];
    expect(sandboxRouteReadinessSchema.safeParse(unreadable[1]).success).toBe(
      false,
    );
    const summary = sandboxSummarySchema.parse({
      ...SANDBOX_VIEW,
      phase: "ready",
      routes: unreadable,
    });
    expect(summary.routes).toBeNull();
    expect(summary.phase).toBe("ready");
    const list = sandboxListResponseSchema.parse({
      sandboxes: [
        SANDBOX_VIEW,
        { ...SANDBOX_VIEW, id: "sbx_2", routes: unreadable },
      ],
    });
    expect(list.sandboxes.map((sandbox) => sandbox.id)).toEqual([
      "sbx_1",
      "sbx_2",
    ]);
    expect(list.sandboxes.map((sandbox) => sandbox.routes)).toEqual([
      null,
      null,
    ]);
  });

  it("refuses a route with an empty id", () => {
    expect(
      sandboxRouteReadinessSchema.safeParse({
        route: "",
        state: "ready",
        code: null,
      }).success,
    ).toBe(false);
  });
});

describe("RPC_ERROR_CODES carries the secrets refusals", () => {
  it.each([
    "authorization_stale",
    "protocol_not_brokered",
    "signing_shape_unsupported",
    "leaf_unavailable",
    "connector_offline",
    "connector_not_enrolled",
    "endpoint_unavailable",
    "h3_only_destination",
    "SANDBOX_GUEST_NOT_CONFIGURED",
  ])("lists %s", (code) => {
    expect(RPC_ERROR_CODES).toContain(code);
  });
});

describe("sandbox summary environmentId", () => {
  it("keeps the environment the sandbox belongs to", () => {
    const parsed = sandboxSummarySchema.parse({
      ...SANDBOX_VIEW,
      environmentId: "env-team-1",
    });
    expect(parsed.environmentId).toBe("env-team-1");
  });

  it("reads a server that predates environments (no key) as null", () => {
    expect(sandboxSummarySchema.parse(SANDBOX_VIEW).environmentId).toBeNull();
  });

  it("keeps an explicit null", () => {
    const parsed = sandboxSummarySchema.parse({
      ...SANDBOX_VIEW,
      environmentId: null,
    });
    expect(parsed.environmentId).toBeNull();
  });

  it("refuses an empty environment id", () => {
    expect(
      sandboxSummarySchema.safeParse({ ...SANDBOX_VIEW, environmentId: "" })
        .success,
    ).toBe(false);
  });

  it("carries the environment through a list response", () => {
    const parsed = sandboxListResponseSchema.parse({
      sandboxes: [
        { ...SANDBOX_VIEW, environmentId: "env-team-1" },
        SANDBOX_VIEW,
      ],
    });
    expect(parsed.sandboxes.map((row) => row.environmentId)).toEqual([
      "env-team-1",
      null,
    ]);
  });
});

describe("a server before the resting clock, keep and today's cost", () => {
  it("reads a summary without the five new fields as nulls", () => {
    const parsed = sandboxSummarySchema.parse(SANDBOX_VIEW);
    expect({
      keptBy: parsed.keptBy,
      restingSince: parsed.restingSince,
      destroyAfterRestingMinutes: parsed.destroyAfterRestingMinutes,
      destroyAt: parsed.destroyAt,
      createdByTaskId: parsed.createdByTaskId,
    }).toEqual({
      keptBy: null,
      restingSince: null,
      destroyAfterRestingMinutes: null,
      destroyAt: null,
      createdByTaskId: null,
    });
  });

  it("reads a cost without todayMillicredits, and its response without todayYoursMillicredits, as 0", () => {
    const cost = {
      sandboxId: "sbx_1",
      currentRateMillicreditsPerHour: 120,
      state: "awake",
      frozen: false,
      charged: {
        computeMillicredits: 300,
        storageMillicredits: 4,
        sinceCreatedAt: 1_791_000_000_000,
      },
      pendingMillicredits: 0,
      segments: [],
    };
    expect(sandboxCostSchema.parse(cost).todayMillicredits).toBe(0);
    const response = userSandboxCostSchema.parse({
      sandboxes: [cost],
      awakeBurnMillicreditsPerHour: 120,
    });
    expect(response.todayYoursMillicredits).toBe(0);
    expect(response.sandboxes[0]?.todayMillicredits).toBe(0);
  });

  it("reads a cost without todayAwakeMs as null, and keeps an explicit value", () => {
    const cost = {
      sandboxId: "sbx_1",
      currentRateMillicreditsPerHour: 120,
      state: "awake",
      frozen: false,
      charged: {
        computeMillicredits: 300,
        storageMillicredits: 4,
        sinceCreatedAt: 1_791_000_000_000,
      },
      pendingMillicredits: 0,
      segments: [],
    };
    expect(sandboxCostSchema.parse(cost).todayAwakeMs).toBeNull();
    expect(
      sandboxCostSchema.parse({ ...cost, todayAwakeMs: 3_600_000 })
        .todayAwakeMs,
    ).toBe(3_600_000);
  });
});
