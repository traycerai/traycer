import type {
  EnvironmentHostRecordV12,
  EnvironmentListResponseV11,
} from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentStatusResponseV12 } from "@traycer/protocol/host/environment-schemas";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";

const HOST_ID = "host-window";
const PERSONAL_ID = "env-personal";
const TEAM_A_ID = "env-team-a";
const TEAM_B_ID = "env-team-b";

const facts = vi.hoisted(() => ({
  methods: new Set<string>(),
  status: null as EnvironmentStatusResponseV12 | null,
  statusFailed: false,
  personal: { environmentId: "env-personal", resolved: true },
  environments: null as EnvironmentListResponseV11 | null,
  listFailed: false,
  hostsByEnvironmentId: new Map<string, readonly EnvironmentHostRecordV12[]>(),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    facts.methods.has(method),
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => ({ data: facts.status, isError: facts.statusFailed }),
}));

vi.mock("@/hooks/environment/use-addressed-environment", () => ({
  usePersonalEnvironment: () => facts.personal,
}));

vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    data: facts.environments ?? undefined,
    error: null,
    isError: facts.listFailed,
  }),
}));

vi.mock("@/hooks/bots/use-environment-host-lists-query", () => ({
  useEnvironmentHostLists: () => ({
    hostsByEnvironmentId: facts.hostsByEnvironmentId,
    failedEnvironmentIds: new Set<string>(),
    retryFailed: () => undefined,
  }),
}));

import { useHostOwnEnvironment } from "@/hooks/environment/use-host-own-environment";

const hostRecord: EnvironmentHostRecordV12 = {
  hostId: HOST_ID,
  hostLabel: "window host",
  hostPlatform: "linux",
  enrolledByUserId: null,
  kind: "personal",
  boundAt: null,
  reachable: true,
  lastReportedAt: null,
  applied: [],
  hasLocalRow: null,
};

const teamEnvironments: EnvironmentListResponseV11 = {
  environments: [
    {
      environmentId: TEAM_A_ID,
      ownerKind: "organization",
      ownerId: "team-a",
      roomId: "room-a",
      label: "Team A",
      effectiveRole: "owner",
      kind: "team",
      hostCount: 1,
      providerHandle: null,
    },
    {
      environmentId: TEAM_B_ID,
      ownerKind: "organization",
      ownerId: "team-b",
      roomId: "room-b",
      label: "Team B",
      effectiveRole: "owner",
      kind: "team",
      hostCount: 1,
      providerHandle: null,
    },
  ],
};

beforeEach(() => {
  facts.methods = new Set(["environment.status"]);
  facts.status = environmentStatusFixture({
    principal: { kind: "personal" },
  });
  facts.statusFailed = false;
  facts.personal = { environmentId: PERSONAL_ID, resolved: true };
  facts.environments = null;
  facts.listFailed = false;
  facts.hostsByEnvironmentId = new Map();
});

afterEach(() => {
  cleanup();
});

describe("useHostOwnEnvironment", () => {
  it("names the listed Personal environment for a Personal host", () => {
    const { result } = renderHook(() =>
      useHostOwnEnvironment(null, HOST_ID, true),
    );

    expect(result.current).toEqual({
      environmentId: PERSONAL_ID,
      resolved: true,
    });
  });

  it("names only the team environment whose authn host list contains this host", () => {
    facts.status = environmentStatusFixture({
      principal: { kind: "team", teamName: "Team B" },
    });
    facts.environments = teamEnvironments;
    facts.hostsByEnvironmentId = new Map([
      [TEAM_A_ID, []],
      [TEAM_B_ID, [hostRecord]],
    ]);

    const { result } = renderHook(() =>
      useHostOwnEnvironment(null, HOST_ID, true),
    );

    expect(result.current).toEqual({
      environmentId: TEAM_B_ID,
      resolved: true,
    });
  });

  it("keeps the team environment unresolved while any host list could still contain this host", () => {
    facts.status = environmentStatusFixture({
      principal: { kind: "team", teamName: "Team B" },
    });
    facts.environments = teamEnvironments;
    facts.hostsByEnvironmentId = new Map([[TEAM_A_ID, []]]);
    facts.listFailed = true;

    const { result } = renderHook(() =>
      useHostOwnEnvironment(null, HOST_ID, true),
    );

    expect(result.current).toEqual({ environmentId: null, resolved: false });
  });

  it("resolves to no named environment when the host does not serve environment.status", () => {
    facts.methods.clear();

    const { result } = renderHook(() =>
      useHostOwnEnvironment(null, HOST_ID, true),
    );

    expect(result.current).toEqual({ environmentId: null, resolved: true });
  });
});
