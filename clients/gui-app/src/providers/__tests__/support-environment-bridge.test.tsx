interface BridgeHarness {
  hostId: string;
  methods: Set<string>;
  client: HostClient<HostRpcRegistry> | null;
}

const harness = vi.hoisted((): BridgeHarness => ({
  hostId: "host-env",
  methods: new Set<string>(),
  client: null,
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => harness.hostId,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => harness.client,
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    harness.methods.has(method),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  EnvironmentReachDiagnosticsResponse,
  EnvironmentSecretV12,
  EnvironmentSecretsRotationResponse,
} from "@traycer/protocol/host/environment-schemas";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  __resetSupportContextRegistryForTests,
  getSupportEnvironmentSection,
  knownField,
  setSupportEnvironmentSection,
} from "@/lib/support-context-registry";
import type { SupportEnvironmentSection } from "@/lib/support-environment-section";
import {
  authnHostRowFixture,
  createOwnEnvironmentAuthRuntime,
  installOwnEnvironmentTransport,
  jsonResponse,
  signInOwnEnvironment,
  type OwnEnvironmentAuthRuntime,
  type OwnEnvironmentRoute,
  type OwnEnvironmentTransport,
} from "@/hooks/environment/__tests__/own-environment-authn-test-support";
import { OwnEnvironmentAuthProvider } from "@/hooks/environment/__tests__/own-environment-auth-provider";
import { SupportEnvironmentBridge } from "@/providers/support-environment-bridge";
import { authnSecret } from "@/components/settings/environment/__tests__/team-environment-cloud-handlers";
import {
  RETIRED_PROVIDER_VARIABLES,
  RETIRED_SECRET_ROW_FIELDS,
} from "@traycer/protocol/host/released-wire-rows";

const HOST_ID = "host-env";
const TEAM_ENV_ID = "env-window-host";
const TEAM_NAME = "Acme Robotics ZZ_TEAM_NAME";

type Rotation = NonNullable<EnvironmentSecretsRotationResponse["rotation"]>;

const STALE_SECTION: SupportEnvironmentSection = {
  hostId: "some-earlier-host",
  principal: "personal",
  reachability: "connected",
  bindingGeneration: null,
  desiredRevision: null,
  receivedRevision: null,
  appliedRevision: null,
  receiptAgeMs: null,
  items: [],
  setupAttempts: null,
  policy: null,
  rotations: null,
  reachDenials: null,
  servedTask: null,
};

const SECRET: EnvironmentSecretV12 = {
  ...RETIRED_SECRET_ROW_FIELDS,
  providerVariables: [...RETIRED_PROVIDER_VARIABLES],
  secretId: "sec-1",
  name: "STRIPE_KEY",
  kind: "api_key",
  protocol: "https",
  destinations: ["api.stripe.com"],
  currentVersionId: "ver-2",
  revoked: false,
  updatedAt: 1,
  variables: [],
};

const SECOND_SECRET: EnvironmentSecretV12 = {
  ...SECRET,
  secretId: "sec-2",
  name: "DATABASE_PASSWORD",
};

const AUTHN_HOST = authnHostRowFixture({
  hostId: HOST_ID,
  hostName: "window host",
  hostKind: "personal",
  hostPlatform: "linux",
  enrolledByUserId: null,
  boundAt: null,
  hasLocalRow: null,
});

// Settled (enforced, every producer proven), so the bridge stops re-reading it.
const ROTATION: Rotation = {
  rotationId: "rot-1",
  fromVersionId: "ver-1",
  toVersionId: "ver-2",
  state: "enforced",
  issuedAt: 1_700_000_000_000,
  producers: [
    {
      producer: "worker",
      workerClass: "sandbox",
      incarnation: "inc-1",
      status: "acknowledged",
      evidence: [{ kind: "session_closed", count: 2 }],
    },
    {
      producer: "host",
      hostId: "host-9",
      incarnation: null,
      status: "applies_on_resume",
      evidence: null,
    },
  ],
};

const MOVING_ROTATION: Rotation = {
  ...ROTATION,
  state: "accepted",
};

let authRuntime: OwnEnvironmentAuthRuntime;
let authnTransport: OwnEnvironmentTransport;
let authnRoute: OwnEnvironmentRoute;

function renderBridge(client: HostClient<HostRpcRegistry>): QueryClient {
  harness.client = client;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <OwnEnvironmentAuthProvider binding={authRuntime.binding}>
      <QueryClientProvider client={queryClient}>
        <SupportEnvironmentBridge />
      </QueryClientProvider>
    </OwnEnvironmentAuthProvider>,
  );
  return queryClient;
}

function replaceAuthnTransport(
  route: OwnEnvironmentRoute,
  environments: ReadonlyArray<{
    readonly environmentId: string;
    readonly ownerKind: "user" | "organization";
    readonly ownerId: string;
    readonly roomId: string;
    readonly label: string;
  }>,
): void {
  authnTransport.restore();
  authnTransport = installOwnEnvironmentTransport(route, { environments });
}

function isSecretsRead(pathname: string): boolean {
  return pathname.includes("/secrets");
}

beforeEach(async () => {
  harness.methods.clear();
  harness.client = null;
  authnRoute = (request) => {
    const path = request.url.pathname;
    if (path === "/api/v3/environments/" + TEAM_ENV_ID + "/hosts") {
      return jsonResponse(200, {
        hosts: [AUTHN_HOST],
      });
    }
    if (path === "/api/v3/environments/" + TEAM_ENV_ID + "/members") {
      return jsonResponse(200, { viewer: { effectiveRole: "editor" } });
    }
    if (path === "/api/v3/environments/" + TEAM_ENV_ID + "/secrets") {
      return jsonResponse(200, {
        secrets: [authnSecret(SECRET)],
      });
    }
    if (
      path ===
      "/api/v3/environments/" + TEAM_ENV_ID + "/secrets/sec-1/rotation"
    ) {
      return jsonResponse(200, { rotation: ROTATION, lastVerify: null });
    }
    return undefined;
  };
  authnTransport = installOwnEnvironmentTransport(authnRoute, {
    environments: [
      {
        environmentId: TEAM_ENV_ID,
        ownerKind: "organization",
        ownerId: "team-1",
        roomId: "room-team",
        label: "Acme",
      },
    ],
  });
  authRuntime = createOwnEnvironmentAuthRuntime();
  await signInOwnEnvironment(authRuntime);
});

afterEach(() => {
  cleanup();
  authnTransport.restore();
  authRuntime.dispose();
  __resetSupportContextRegistryForTests();
  vi.useRealTimers();
});

describe("SupportEnvironmentBridge", () => {
  it("leaves the section unavailable when the host does not serve environment.status", async () => {
    // A section an earlier host left behind: the bridge must overwrite it,
    // not merely fail to add one.
    setSupportEnvironmentSection(knownField(STALE_SECTION));
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {},
    });

    renderBridge(client);

    await waitFor(() => {
      expect(getSupportEnvironmentSection()).toEqual({
        status: "unavailable",
      });
    });
    expect(
      authnTransport.requests.some((request) =>
        isSecretsRead(request.url.pathname),
      ),
    ).toBe(false);
  });

  it("does not read a null environment after every team host list excludes this host", async () => {
    harness.methods.add("environment.status");
    const environments = [
      {
        environmentId: TEAM_ENV_ID,
        ownerKind: "organization" as const,
        ownerId: "team-1",
        roomId: "room-team",
        label: "Acme",
      },
    ];
    replaceAuthnTransport((request) => {
      const path = request.url.pathname;
      if (path.endsWith("/hosts")) return jsonResponse(200, { hosts: [] });
      if (path.endsWith("/members")) {
        return jsonResponse(200, { viewer: { effectiveRole: "editor" } });
      }
      return undefined;
    }, environments);
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({
            principal: { kind: "team", teamName: TEAM_NAME },
          }),
      },
    });

    renderBridge(client);

    await waitFor(() => {
      const field = getSupportEnvironmentSection();
      expect(field.status).toBe("known");
    });
    expect(
      authnTransport.requests.some((request) =>
        isSecretsRead(request.url.pathname),
      ),
    ).toBe(false);
    expect(getSupportEnvironmentSection()).toMatchObject({
      status: "known",
      value: { rotations: null },
    });
  });

  it("does not read secrets when environment.status names no principal", async () => {
    harness.methods.add("environment.status");
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({ principal: null }),
      },
    });

    renderBridge(client);

    await waitFor(() => {
      const field = getSupportEnvironmentSection();
      expect(field.status).toBe("known");
    });
    expect(
      authnTransport.requests.some((request) =>
        isSecretsRead(request.url.pathname),
      ),
    ).toBe(false);
    expect(getSupportEnvironmentSection()).toMatchObject({
      status: "known",
      value: { rotations: null },
    });
  });

  it("does not name secrets from a cold failed Personal directory read", async () => {
    harness.methods.add("environment.status");
    replaceAuthnTransport(
      (request) =>
        request.url.pathname === "/api/environments"
          ? jsonResponse(503, {})
          : undefined,
      [
        {
          environmentId: "env-personal",
          ownerKind: "user",
          ownerId: "user-1",
          roomId: "room-personal",
          label: "Personal",
        },
      ],
    );
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({
            principal: { kind: "personal" },
          }),
      },
    });

    renderBridge(client);

    await waitFor(() => {
      const field = getSupportEnvironmentSection();
      expect(field.status).toBe("known");
    });
    expect(
      authnTransport.requests.some((request) =>
        isSecretsRead(request.url.pathname),
      ),
    ).toBe(false);
    expect(getSupportEnvironmentSection()).toMatchObject({
      status: "known",
      value: { rotations: null },
    });
  });

  it("writes a known section carrying the listed secret's name and its producers", async () => {
    for (const method of ["environment.status", "environment.setup.attempts"]) {
      harness.methods.add(method);
    }
    const hostSecretReads: string[] = [];
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({
            principal: { kind: "team", teamName: TEAM_NAME },
            reachability: "connected",
          }),
        "environment.setup.attempts": () => ({ attempts: [] }),
        "environment.secrets.list": () => {
          hostSecretReads.push("list");
          return { removed: [], secrets: [SECRET] };
        },
        "environment.secrets.rotation": () => {
          hostSecretReads.push("rotation");
          return { rotation: ROTATION, lastVerify: null };
        },
      },
    });

    renderBridge(client);

    await waitFor(() => {
      const field = getSupportEnvironmentSection();
      if (field.status !== "known") throw new Error("not known yet");
      expect(field.value.rotations).toHaveLength(1);
    });

    const field = getSupportEnvironmentSection();
    if (field.status !== "known") throw new Error("the section is not known");
    const section = field.value;
    expect(section.hostId).toBe(HOST_ID);
    expect(section.principal).toBe("team");
    expect(section.setupAttempts).toEqual([]);
    expect(section.rotations).toEqual([
      {
        secretName: "STRIPE_KEY",
        state: "enforced",
        producers: [
          {
            producer: "worker",
            workerClass: "sandbox",
            hostId: null,
            hostName: null,
            status: "acknowledged",
            evidence: [{ kind: "session_closed", count: 2 }],
          },
          {
            producer: "host",
            workerClass: null,
            hostId: "host-9",
            hostName: null,
            status: "applies_on_resume",
            evidence: null,
          },
        ],
      },
    ]);
    expect(hostSecretReads).toEqual([]);
    expect(
      authnTransport.requests
        .filter((request) => request.url.pathname.includes("/secrets"))
        .map((request) => request.url.pathname),
    ).toEqual([
      "/api/v3/environments/" + TEAM_ENV_ID + "/secrets",
      "/api/v3/environments/" + TEAM_ENV_ID + "/secrets/sec-1/rotation",
    ]);
    // The team travels as a category; its name does not.
    expect(JSON.stringify(section)).not.toContain(TEAM_NAME);
  });

  it("waits for the failed team host list and reads secrets only after its retry names env-b", async () => {
    const environmentA = "env-team-a";
    const environmentB = "env-team-b";
    harness.methods.add("environment.status");
    useAuthStore.setState({
      shareableTeams: [
        { teamId: "team-a", slug: "a", avatarUrl: null },
        { teamId: "team-b", slug: "b", avatarUrl: null },
      ],
    });
    let environmentBHostListFails = true;
    const directory = {
      environments: [
        {
          environmentId: environmentA,
          ownerKind: "organization" as const,
          ownerId: "team-a",
          roomId: "room-a",
          label: "A",
        },
        {
          environmentId: environmentB,
          ownerKind: "organization" as const,
          ownerId: "team-b",
          roomId: "room-b",
          label: "B",
        },
      ],
    };
    authnTransport.restore();
    authnTransport = installOwnEnvironmentTransport((request) => {
      const path = request.url.pathname;
      if (path.endsWith("/hosts")) {
        if (path.includes(environmentB) && environmentBHostListFails) {
          return jsonResponse(503, {});
        }
        return jsonResponse(200, {
          hosts: path.includes(environmentB) ? [AUTHN_HOST] : [],
        });
      }
      if (path.endsWith("/members")) {
        return jsonResponse(200, { viewer: { effectiveRole: "editor" } });
      }
      if (path.endsWith("/secrets/sec-1/rotation")) {
        return jsonResponse(200, { rotation: ROTATION, lastVerify: null });
      }
      if (path.endsWith("/secrets")) {
        return jsonResponse(200, { secrets: [authnSecret(SECRET)] });
      }
      return undefined;
    }, directory);
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({
            principal: { kind: "team", teamName: TEAM_NAME },
          }),
      },
    });

    const queryClient = renderBridge(client);

    await waitFor(() => {
      expect(
        queryClient.getQueryCache().findAll({
          predicate: (query) =>
            query.queryKey.includes("environment.host.list") &&
            query.state.status === "error",
        }),
      ).toHaveLength(1);
    });
    expect(getSupportEnvironmentSection()).toMatchObject({
      status: "known",
      value: { rotations: null },
    });
    expect(
      authnTransport.requests.some((request) =>
        request.url.pathname.endsWith("/secrets"),
      ),
    ).toBe(false);

    const environmentBHostReadsBeforeRetry = authnTransport.requests.filter(
      (request) =>
        request.url.pathname ===
        "/api/v3/environments/" + environmentB + "/hosts",
    ).length;
    environmentBHostListFails = false;
    await queryClient.refetchQueries({
      predicate: (query) =>
        query.queryKey.includes("environment.host.list") &&
        query.state.status === "error",
    });
    await waitFor(() => {
      const field = getSupportEnvironmentSection();
      if (field.status !== "known") throw new Error("not known yet");
      expect(field.value.rotations).toHaveLength(1);
    });
    expect(
      authnTransport.requests.some(
        (request) =>
          request.url.pathname ===
          "/api/v3/environments/" + environmentB + "/secrets",
      ),
    ).toBe(true);
    expect(
      authnTransport.requests.some(
        (request) =>
          request.url.pathname ===
          "/api/v3/environments/" + environmentA + "/secrets",
      ),
    ).toBe(false);
    expect(
      authnTransport.requests.filter(
        (request) =>
          request.url.pathname ===
          "/api/v3/environments/" + environmentB + "/hosts",
      ).length,
    ).toBeGreaterThan(environmentBHostReadsBeforeRetry);
  });

  it("reads each rotation and polls only the moving one until it settles", async () => {
    harness.methods.add("environment.status");
    harness.methods.add("environment.setup.attempts");
    const rotationReads = new Map<string, number>();
    const environments = [
      {
        environmentId: TEAM_ENV_ID,
        ownerKind: "organization" as const,
        ownerId: "team-1",
        roomId: "room-team",
        label: "Acme",
      },
    ];
    replaceAuthnTransport((request) => {
      const path = request.url.pathname;
      if (path.endsWith("/hosts")) {
        return jsonResponse(200, {
          hosts: [AUTHN_HOST],
        });
      }
      if (path.endsWith("/members")) {
        return jsonResponse(200, { viewer: { effectiveRole: "editor" } });
      }
      if (path.endsWith("/secrets")) {
        return jsonResponse(200, {
          secrets: [authnSecret(SECRET), authnSecret(SECOND_SECRET)],
        });
      }
      if (path.endsWith("/rotation")) {
        const secretId = path.split("/").at(-2);
        if (secretId === undefined) {
          throw new Error("rotation path had no secret id");
        }
        const count = (rotationReads.get(secretId) ?? 0) + 1;
        rotationReads.set(secretId, count);
        return jsonResponse(200, {
          rotation:
            secretId === "sec-1" && count === 1 ? MOVING_ROTATION : ROTATION,
          lastVerify: null,
        });
      }
      return undefined;
    }, environments);
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({
            principal: { kind: "team", teamName: TEAM_NAME },
          }),
        "environment.setup.attempts": () => ({ attempts: [] }),
      },
    });

    vi.useFakeTimers();
    renderBridge(client);

    for (let turn = 0; turn < 20; turn += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
    }
    expect(rotationReads.get("sec-1")).toBe(1);
    expect(rotationReads.get("sec-2")).toBe(1);
    const field = getSupportEnvironmentSection();
    if (field.status !== "known") throw new Error("the section is not known");
    expect(field.value.rotations).toHaveLength(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(rotationReads.get("sec-1")).toBe(2);
    expect(rotationReads.get("sec-2")).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(rotationReads.get("sec-1")).toBe(2);
    expect(rotationReads.get("sec-2")).toBe(1);
    expect(
      authnTransport.requests.some((request) =>
        request.url.pathname.endsWith("/rotation"),
      ),
    ).toBe(true);
  });

  it("reads Personal secrets through authn when the host serves status but does not advertise secrets list", async () => {
    harness.methods.add("environment.status");
    harness.methods.add("environment.setup.attempts");
    expect(harness.methods.has("environment.secrets.list")).toBe(false);
    replaceAuthnTransport(
      (request) => {
        const path = request.url.pathname;
        if (path.endsWith("/secrets/sec-1/rotation")) {
          return jsonResponse(200, { rotation: ROTATION, lastVerify: null });
        }
        if (path.endsWith("/secrets")) {
          return jsonResponse(200, { secrets: [authnSecret(SECRET)] });
        }
        return undefined;
      },
      [
        {
          environmentId: "env-personal",
          ownerKind: "user",
          ownerId: "user-1",
          roomId: "room-personal",
          label: "Personal",
        },
      ],
    );
    const hostReads: string[] = [];
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({
            principal: { kind: "personal" },
            reachability: "connected",
          }),
        "environment.setup.attempts": () => {
          hostReads.push("attempts");
          return { attempts: [] };
        },
        "environment.secrets.list": () => {
          hostReads.push("list");
          return { removed: [], secrets: [SECRET] };
        },
        "environment.secrets.rotation": () => {
          hostReads.push("rotation");
          return { rotation: ROTATION, lastVerify: null };
        },
      },
    });

    renderBridge(client);

    await waitFor(() => {
      const field = getSupportEnvironmentSection();
      if (field.status !== "known") throw new Error("not known yet");
      expect(field.value.rotations).toHaveLength(1);
    });
    const field = getSupportEnvironmentSection();
    if (field.status !== "known") throw new Error("the section is not known");
    expect(field.value.principal).toBe("personal");
    expect(field.value.setupAttempts).toEqual([]);
    expect(hostReads).toEqual(["attempts"]);
    expect(
      authnTransport.requests
        .filter((request) => request.url.pathname.includes("/secrets"))
        .map((request) => request.url.pathname),
    ).toEqual([
      "/api/v3/environments/env-personal/secrets",
      "/api/v3/environments/env-personal/secrets/sec-1/rotation",
    ]);
  });

  it("carries the host's reach denials and served task when it serves environment.reachDiagnostics", async () => {
    for (const method of [
      "environment.status",
      "environment.reachDiagnostics",
    ]) {
      harness.methods.add(method);
    }
    const reach: EnvironmentReachDiagnosticsResponse = {
      denials: [
        {
          denialId: "denial-1",
          at: 1_700_000_000_000,
          sourceHostRef: "host-ref-source",
          targetHostRef: "host-ref-target",
          taskRef: "task-ref-1",
          reason: "principal_mismatch",
          sourcePrincipal: "personal",
          targetPrincipal: "team",
          count: 2,
        },
      ],
      servedTask: { taskRef: "task-ref-1", otherHostPrincipals: ["team"] },
    };
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () => environmentStatusFixture({}),
        "environment.reachDiagnostics": () => reach,
      },
    });

    renderBridge(client);

    await waitFor(() => {
      const field = getSupportEnvironmentSection();
      if (field.status !== "known") throw new Error("not known yet");
      expect(field.value.reachDenials).toHaveLength(1);
    });

    const field = getSupportEnvironmentSection();
    if (field.status !== "known") throw new Error("the section is not known");
    expect(field.value.reachDenials).toEqual(reach.denials);
    expect(field.value.servedTask).toEqual(reach.servedTask);
  });
});
