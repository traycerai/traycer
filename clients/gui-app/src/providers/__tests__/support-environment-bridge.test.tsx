// The bridge reads three hooks that answer from process-wide state (which host
// is selected, the client for it, and what it negotiated). A test pins those
// three and leaves the rest real: the queries run through a real `HostClient`
// over an in-memory messenger, so the reads travel the path the app uses.
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
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  EnvironmentReachDiagnosticsResponse,
  EnvironmentSecret,
  EnvironmentSecretsRotationResponse,
} from "@traycer/protocol/host/environment-schemas";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import {
  __resetSupportContextRegistryForTests,
  getSupportEnvironmentSection,
  knownField,
  setSupportEnvironmentSection,
} from "@/lib/support-context-registry";
import type { SupportEnvironmentSection } from "@/lib/support-environment-section";
import { SupportEnvironmentBridge } from "@/providers/support-environment-bridge";

const HOST_ID = "host-env";
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

const SECRET: EnvironmentSecret = {
  secretId: "sec-1",
  name: "STRIPE_KEY",
  kind: "api_key",
  protocol: "https",
  destinations: ["api.stripe.com"],
  mode: "brokered",
  state: "live",
  currentVersionId: "ver-2",
  revoked: false,
  updatedAt: 1,
};

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

function renderBridge(client: HostClient<HostRpcRegistry>): void {
  harness.client = client;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SupportEnvironmentBridge />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  harness.methods.clear();
  harness.client = null;
});

afterEach(() => {
  cleanup();
  __resetSupportContextRegistryForTests();
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
  });

  it("writes a known section carrying the listed secret's name and its producers", async () => {
    for (const method of [
      "environment.status",
      "environment.setup.attempts",
      "environment.secrets.list",
    ]) {
      harness.methods.add(method);
    }
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({
            principal: { kind: "team", teamName: TEAM_NAME },
            reachability: "connected",
          }),
        "environment.setup.attempts": () => ({ attempts: [] }),
        "environment.secrets.list": () => ({ removed: [], secrets: [SECRET] }),
        "environment.secrets.rotation": () => ({
          rotation: ROTATION,
          lastVerify: null,
        }),
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
    // The team travels as a category; its name does not.
    expect(JSON.stringify(section)).not.toContain(TEAM_NAME);
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
