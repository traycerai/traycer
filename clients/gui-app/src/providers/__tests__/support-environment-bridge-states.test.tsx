// What the bridge writes while the selected host answers, stops answering, goes
// away or is swapped for another. The sibling suite pins one happy path and the
// unsupported one; this one pins the states a report is actually opened in:
// `unavailable` until the SELECTED host has answered, `stale` on a failed read,
// never another host's section, and the reads it makes (and does not make) of a
// host that lacks them.
//
// The same three process-wide hooks are pinned here as there; the account
// policy's own hook is stood in so its answer, body included, is a value the
// test controls.
interface BridgeHarness {
  hostId: string | null;
  methods: Set<string>;
  client: HostClient<HostRpcRegistry> | null;
  policy: { readonly data: unknown } | null;
}

const harness = vi.hoisted((): BridgeHarness => ({
  hostId: "host-env",
  methods: new Set<string>(),
  client: null,
  policy: null,
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

vi.mock("@/hooks/auto-mode/use-auto-policy-query", () => ({
  useAutoPolicyQuery: () => harness.policy ?? { data: undefined },
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  EnvironmentSecretV12,
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

// These cases are about the environments-on behaviour.
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: () => "on" as const,
}));

type Rotation = NonNullable<EnvironmentSecretsRotationResponse["rotation"]>;

const EARLIER_HOST_SECTION: SupportEnvironmentSection = {
  hostId: "host-earlier",
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

function secret(secretId: string, name: string): EnvironmentSecretV12 {
  return {
    secretId,
    name,
    kind: "api_key",
    protocol: "https",
    destinations: ["api.stripe.com"],
    mode: "brokered",
    state: "live",
    currentVersionId: "ver-2",
    revoked: false,
    updatedAt: 1,
    variables: [],
    providerVariables: [],
  };
}

function rotation(state: Rotation["state"], proven: boolean): Rotation {
  return {
    rotationId: "rot-1",
    fromVersionId: "ver-1",
    toVersionId: "ver-2",
    state,
    issuedAt: 1_700_000_000_000,
    producers: [
      {
        producer: "worker",
        workerClass: "https",
        incarnation: "inc-1",
        status: proven ? "acknowledged" : "missing",
        evidence: proven ? [{ kind: "session_closed", count: 2 }] : null,
      },
    ],
  };
}

const NEVER: Promise<never> = new Promise(() => undefined);

let queryClient: QueryClient;

function mountBridge(client: HostClient<HostRpcRegistry>): {
  readonly rerender: () => void;
} {
  harness.client = client;
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <SupportEnvironmentBridge />
    </QueryClientProvider>
  );
  const view = render(tree());
  return { rerender: () => view.rerender(tree()) };
}

function supportAll(): void {
  for (const method of [
    "environment.status",
    "environment.setup.attempts",
    "environment.secrets.list",
  ]) {
    harness.methods.add(method);
  }
}

function knownSection(): SupportEnvironmentSection {
  const field = getSupportEnvironmentSection();
  if (field.status !== "known") {
    throw new Error(`the section is ${field.status}, not known`);
  }
  return field.value;
}

beforeEach(() => {
  harness.hostId = "host-env";
  harness.methods.clear();
  harness.client = null;
  harness.policy = null;
});

afterEach(() => {
  cleanup();
  __resetSupportContextRegistryForTests();
});

describe("SupportEnvironmentBridge's states", () => {
  it("is unavailable, not the last host's section, until the selected host has answered", async () => {
    supportAll();
    setSupportEnvironmentSection(knownField(EARLIER_HOST_SECTION));
    const { client } = buildEnvironmentClient({
      hostId: "host-env",
      handlers: { "environment.status": () => NEVER },
    });

    mountBridge(client);

    await waitFor(() => {
      expect(getSupportEnvironmentSection()).toEqual({ status: "unavailable" });
    });
  });

  it("is unavailable when the window has no host at all", async () => {
    harness.hostId = null;
    setSupportEnvironmentSection(knownField(EARLIER_HOST_SECTION));
    const { client } = buildEnvironmentClient({ hostId: "x", handlers: {} });

    mountBridge(client);

    await waitFor(() => {
      expect(getSupportEnvironmentSection()).toEqual({ status: "unavailable" });
    });
  });

  it("keeps the last answer, labelled stale, when the host stops answering", async () => {
    supportAll();
    let fail = false;
    const { client } = buildEnvironmentClient({
      hostId: "host-env",
      handlers: {
        "environment.status": () => {
          if (fail) throw new Error("host went away");
          return environmentStatusFixture({ reachability: "connected" });
        },
        "environment.setup.attempts": () => ({ attempts: [] }),
        "environment.secrets.list": () => ({ removed: [], secrets: [] }),
      },
    });
    mountBridge(client);
    await waitFor(() => {
      expect(getSupportEnvironmentSection().status).toBe("known");
    });

    fail = true;
    await queryClient.invalidateQueries();

    await waitFor(() => {
      expect(getSupportEnvironmentSection().status).toBe("stale");
    });
    const field = getSupportEnvironmentSection();
    if (field.status !== "stale") throw new Error("not stale");
    expect(field.value.hostId).toBe("host-env");
    expect(field.value.reachability).toBe("connected");
  });

  it("never carries the previous host's section after the selection moves", async () => {
    supportAll();
    const first = buildEnvironmentClient({
      hostId: "host-a",
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({ reachability: "connected" }),
        "environment.setup.attempts": () => ({ attempts: [] }),
        "environment.secrets.list": () => ({ removed: [], secrets: [] }),
      },
    });
    harness.hostId = "host-a";
    const view = mountBridge(first.client);
    await waitFor(() => {
      expect(knownSection().hostId).toBe("host-a");
    });

    const second = buildEnvironmentClient({
      hostId: "host-b",
      handlers: { "environment.status": () => NEVER },
    });
    harness.hostId = "host-b";
    harness.client = second.client;
    view.rerender();

    await waitFor(() => {
      expect(getSupportEnvironmentSection()).toEqual({ status: "unavailable" });
    });
  });

  it("starts the new host's rotations from nothing, whichever secret ids the two hosts share", async () => {
    supportAll();
    const first = buildEnvironmentClient({
      hostId: "host-a",
      handlers: {
        "environment.status": () => environmentStatusFixture({}),
        "environment.setup.attempts": () => ({ attempts: [] }),
        "environment.secrets.list": () => ({
          removed: [],
          secrets: [secret("sec-1", "STRIPE_KEY")],
        }),
        "environment.secrets.rotation": () => ({
          rotation: rotation("enforced", true),
          lastVerify: null,
        }),
      },
    });
    harness.hostId = "host-a";
    const view = mountBridge(first.client);
    await waitFor(() => {
      expect(knownSection().rotations).toHaveLength(1);
    });

    const second = buildEnvironmentClient({
      hostId: "host-b",
      handlers: {
        "environment.status": () => environmentStatusFixture({}),
        "environment.setup.attempts": () => ({ attempts: [] }),
        "environment.secrets.list": () => ({
          removed: [],
          secrets: [secret("sec-1", "STRIPE_KEY")],
        }),
        "environment.secrets.rotation": () => NEVER,
      },
    });
    harness.hostId = "host-b";
    harness.client = second.client;
    view.rerender();

    await waitFor(() => {
      expect(knownSection().hostId).toBe("host-b");
    });
    expect(knownSection().rotations).toEqual([]);
  });

  it("asks a host that lacks environment.status for nothing else", async () => {
    harness.methods.add("environment.setup.attempts");
    harness.methods.add("environment.secrets.list");
    let attempts = 0;
    let listed = 0;
    const { client } = buildEnvironmentClient({
      hostId: "host-env",
      handlers: {
        "environment.setup.attempts": () => {
          attempts += 1;
          return { attempts: [] };
        },
        "environment.secrets.list": () => {
          listed += 1;
          return { removed: [], secrets: [] };
        },
      },
    });

    mountBridge(client);

    await waitFor(() => {
      expect(getSupportEnvironmentSection()).toEqual({ status: "unavailable" });
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(attempts).toBe(0);
    expect(listed).toBe(0);
  });

  it("has no rotations to report until the secrets have been listed", async () => {
    supportAll();
    const { client } = buildEnvironmentClient({
      hostId: "host-env",
      handlers: {
        "environment.status": () => environmentStatusFixture({}),
        "environment.setup.attempts": () => ({ attempts: [] }),
        "environment.secrets.list": () => NEVER,
      },
    });

    mountBridge(client);

    await waitFor(() => {
      expect(knownSection().setupAttempts).toEqual([]);
    });
    expect(knownSection().rotations).toBeNull();
  });

  it("carries the account policy's source and read state, never its body", async () => {
    supportAll();
    harness.methods.add("autoPolicy.get");
    harness.policy = {
      data: {
        body: "ZZ_POLICY_BODY never ship",
        updatedAt: "2026-10-01T00:00:00.000Z",
        source: "account",
        readState: "stale",
      },
    };
    const { client } = buildEnvironmentClient({
      hostId: "host-env",
      handlers: {
        "environment.status": () => environmentStatusFixture({}),
        "environment.setup.attempts": () => ({ attempts: [] }),
        "environment.secrets.list": () => ({ removed: [], secrets: [] }),
      },
    });

    mountBridge(client);

    await waitFor(() => {
      expect(knownSection().policy).toEqual({
        source: "account",
        readState: "stale",
        teamState: null,
        teamPolicyVersion: null,
      });
    });
    expect(JSON.stringify(knownSection())).not.toContain("ZZ_POLICY_BODY");
  });

  it.each([
    ["applied", "42", { state: "applied", policyVersion: "42" }],
    ["lapsed", "42", { state: "lapsed", policyVersion: "42" }],
    ["none", null, { state: "none", policyVersion: null }],
  ] as const)(
    "shows a team host's policy state %s and its version, and still never a body",
    async (teamState, teamPolicyVersion, team) => {
      supportAll();
      harness.methods.add("autoPolicy.get");
      harness.policy = {
        data: {
          body: "ZZ_ACCOUNT_BODY never ship",
          updatedAt: "2026-10-01T00:00:00.000Z",
          source: "account",
          readState: "fresh",
          team,
        },
      };
      const { client } = buildEnvironmentClient({
        hostId: "host-env",
        handlers: {
          "environment.status": () => environmentStatusFixture({}),
          "environment.setup.attempts": () => ({ attempts: [] }),
          "environment.secrets.list": () => ({ removed: [], secrets: [] }),
        },
      });

      mountBridge(client);

      await waitFor(() => {
        expect(knownSection().policy).toEqual({
          source: "account",
          readState: "fresh",
          teamState,
          teamPolicyVersion,
        });
      });
      expect(JSON.stringify(knownSection())).not.toContain("ZZ_ACCOUNT_BODY");
    },
  );

  it("reads a personal host (team: null) and a host older than 1.1 (no team key) the same: null and null", async () => {
    supportAll();
    harness.methods.add("autoPolicy.get");
    harness.policy = {
      data: {
        body: null,
        updatedAt: null,
        source: "account",
        readState: "fresh",
        team: null,
      },
    };
    const { client } = buildEnvironmentClient({
      hostId: "host-env",
      handlers: {
        "environment.status": () => environmentStatusFixture({}),
        "environment.setup.attempts": () => ({ attempts: [] }),
        "environment.secrets.list": () => ({ removed: [], secrets: [] }),
      },
    });

    mountBridge(client);

    await waitFor(() => {
      expect(knownSection().policy).toEqual({
        source: "account",
        readState: "fresh",
        teamState: null,
        teamPolicyVersion: null,
      });
    });
  });

  it("drops a secret from the section when the list no longer has it", async () => {
    supportAll();
    let secrets = [secret("sec-1", "STRIPE_KEY"), secret("sec-2", "GH_TOKEN")];
    const { client } = buildEnvironmentClient({
      hostId: "host-env",
      handlers: {
        "environment.status": () => environmentStatusFixture({}),
        "environment.setup.attempts": () => ({ attempts: [] }),
        "environment.secrets.list": () => ({ removed: [], secrets }),
        "environment.secrets.rotation": () => ({
          rotation: rotation("enforced", true),
          lastVerify: null,
        }),
      },
    });
    mountBridge(client);
    await waitFor(() => {
      expect(
        knownSection()
          .rotations?.map((entry) => entry.secretName)
          .sort(),
      ).toEqual(["GH_TOKEN", "STRIPE_KEY"]);
    });

    secrets = [secret("sec-1", "STRIPE_KEY")];
    await queryClient.invalidateQueries();

    await waitFor(() => {
      expect(
        knownSection().rotations?.map((entry) => entry.secretName),
      ).toEqual(["STRIPE_KEY"]);
    });
  });
});

describe("SupportEnvironmentBridge's rotation reads", () => {
  function rotationHost(settled: boolean): {
    readonly client: HostClient<HostRpcRegistry>;
    readonly reads: () => number;
  } {
    let reads = 0;
    const { client } = buildEnvironmentClient({
      hostId: "host-env",
      handlers: {
        "environment.status": () => environmentStatusFixture({}),
        "environment.setup.attempts": () => ({ attempts: [] }),
        "environment.secrets.list": () => ({
          removed: [],
          secrets: [secret("sec-1", "STRIPE_KEY")],
        }),
        "environment.secrets.rotation": () => {
          reads += 1;
          return {
            rotation: settled
              ? rotation("enforced", true)
              : rotation("enforcing", false),
            lastVerify: null,
          };
        },
      },
    });
    return { client, reads: () => reads };
  }

  it("re-reads a rotation that is still moving", async () => {
    supportAll();
    const host = rotationHost(false);

    mountBridge(host.client);

    await waitFor(
      () => {
        expect(host.reads()).toBeGreaterThanOrEqual(2);
      },
      { timeout: 8000, interval: 200 },
    );
  }, 15000);

  it("stops re-reading a rotation once every producer has proved it", async () => {
    supportAll();
    const host = rotationHost(true);

    mountBridge(host.client);

    await waitFor(() => {
      expect(host.reads()).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    expect(host.reads()).toBe(1);
  }, 15000);
});
