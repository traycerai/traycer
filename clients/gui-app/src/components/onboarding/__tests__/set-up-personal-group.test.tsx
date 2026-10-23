// The group reads the window's own host: the client and its host id come from
// the app-wide hooks. Mocked at those boundaries; the client is a REAL
// `HostClient` over an in-memory messenger, so only the host is faked.
const hostMock = vi.hoisted((): { client: unknown; hostId: string | null } => ({
  client: null,
  hostId: null,
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useOptionalHostClient: () => hostMock.client };
});
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => hostMock.hostId,
}));

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: navigateMock,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  EnvironmentSecret,
  EnvironmentStatusResponseV11,
} from "@traycer/protocol/host/environment-schemas";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { SetUpPersonalGroup } from "@/components/onboarding/set-up-personal-group";
import {
  profile,
  provider,
} from "@/components/settings/panels/permissions/__tests__/judge-test-support";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
  itemStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";

const HOST_ID = "host-a";
const ALL_METHODS = [
  "environment.status",
  "environment.secrets.list",
  "providers.list",
];

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  hostMock.client = null;
  hostMock.hostId = null;
  navigateMock.mockReset();
});

interface HostFacts {
  readonly providers: ProviderCliState[];
  readonly secrets: EnvironmentSecret[];
  readonly status: EnvironmentStatusResponseV11;
  /** The methods the host advertises. */
  readonly methods: readonly string[];
}

interface HostCalls {
  providers: number;
  secrets: number;
  status: number;
}

const NOTHING: HostFacts = {
  providers: [],
  secrets: [],
  status: environmentStatusFixture({}),
  methods: ALL_METHODS,
};

function secret(overrides: Partial<EnvironmentSecret>): EnvironmentSecret {
  return {
    secretId: "secret-1",
    name: "DEPLOY_KEY",
    kind: "api_key",
    protocol: null,
    destinations: [],
    mode: "brokered",
    state: "live",
    currentVersionId: "v1",
    revoked: false,
    updatedAt: 1,
    ...overrides,
  };
}

function managedLinked(): ProviderCliState {
  const linked: ProviderProfile = profile("work", "managed");
  return provider("claude-code", [linked]);
}

function storedKey(): ProviderCliState {
  return {
    ...provider("codex", []),
    apiKey: { supported: true, configured: true, source: "stored" },
  };
}

function guideStatus(): EnvironmentStatusResponseV11 {
  return environmentStatusFixture({
    items: [itemStatusFixture({ kind: "agent_selection_guide", key: "guide" })],
  });
}

function renderGroup(
  facts: HostFacts,
  surface: "settings" | "home",
): HostCalls {
  const calls: HostCalls = { providers: 0, secrets: 0, status: 0 };
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "providers.list": () => {
      calls.providers += 1;
      return { providers: [...facts.providers], native: null };
    },
    "environment.secrets.list": () => {
      calls.secrets += 1;
      return { secrets: [...facts.secrets] };
    },
    "environment.status": () => {
      calls.status += 1;
      return facts.status;
    },
  };
  const { client } = buildEnvironmentClient({ hostId: HOST_ID, handlers });
  recordNegotiatedHostMethods(HOST_ID, facts.methods);
  hostMock.client = client;
  hostMock.hostId = HOST_ID;
  mount(surface);
  return calls;
}

function mount(surface: "settings" | "home"): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SetUpPersonalGroup surface={surface} />
    </QueryClientProvider>,
  );
}

function marks(): string[] {
  return screen
    .getAllByTestId("set-up-personal-step")
    .map(
      (step) =>
        `${step.getAttribute("data-step")}=${step.getAttribute("data-done")}`,
    );
}

function progress(): string {
  return screen.getByTestId("set-up-personal-progress").textContent;
}

/** Lets everything a NEGATIVE assertion depends on happen first. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  });
}

describe("<SetUpPersonalGroup />", () => {
  it("lists the three steps in the person's words", () => {
    renderGroup(NOTHING, "settings");

    expect(
      screen.getByRole("heading", { name: "Set up Personal" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Optional. An agent can run as soon as one provider is set up.",
      ),
    ).toBeTruthy();
    const steps = screen.getAllByTestId("set-up-personal-step");
    expect(steps.map((step) => step.textContent)).toEqual([
      expect.stringContaining(
        "Link a plan or add an API key, so your agents can run on every host.",
      ),
      expect.stringContaining(
        "Add a secret your agents will need, like a deploy key or a login.",
      ),
      expect.stringContaining("Choose how agents are picked for each task."),
    ]);
    expect(
      within(steps[0]).getByRole("button", { name: "Open Providers" }),
    ).toBeTruthy();
    expect(
      within(steps[1]).getByRole("button", { name: "Open Secrets" }),
    ).toBeTruthy();
    expect(
      within(steps[2]).getByRole("button", { name: "Open Agent selection" }),
    ).toBeTruthy();
  });

  it("draws on both surfaces", () => {
    renderGroup(NOTHING, "home");

    expect(screen.getByTestId("set-up-personal")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Set up Personal" }),
    ).toBeTruthy();
  });

  it("checks nothing off for a host with nothing set up", async () => {
    const calls = renderGroup(NOTHING, "settings");

    await waitFor(() => {
      expect(calls.providers).toBeGreaterThan(0);
      expect(calls.secrets).toBeGreaterThan(0);
      expect(calls.status).toBeGreaterThan(0);
    });
    await settle();
    expect(marks()).toEqual(["provider=false", "secret=false", "agents=false"]);
    expect(progress()).toBe("0 of 3 done");
  });

  it("checks every step off from the host's reads alone, as when each was done in the dashboard", async () => {
    renderGroup(
      {
        ...NOTHING,
        providers: [managedLinked()],
        secrets: [secret({})],
        status: guideStatus(),
      },
      "settings",
    );

    await waitFor(() => {
      expect(progress()).toBe("Done");
    });
    expect(marks()).toEqual(["provider=true", "secret=true", "agents=true"]);
    // A done step says so to assistive technology.
    expect(screen.getAllByLabelText("Done")).toHaveLength(3);
  });

  it("checks off a stored API key as the provider step, and only that step", async () => {
    renderGroup({ ...NOTHING, providers: [storedKey()] }, "settings");

    await waitFor(() => {
      expect(progress()).toBe("1 of 3 done");
    });
    expect(marks()).toEqual(["provider=true", "secret=false", "agents=false"]);
  });

  it("checks off a live secret as the secret step, and the agent guide as the agents step", async () => {
    renderGroup(
      { ...NOTHING, secrets: [secret({})], status: guideStatus() },
      "settings",
    );

    await waitFor(() => {
      expect(progress()).toBe("2 of 3 done");
    });
    expect(marks()).toEqual(["provider=false", "secret=true", "agents=true"]);
  });

  it("does not count this computer's own sign-in, a key from a shell variable or a revoked secret", async () => {
    const ambientOnly = provider("claude-code", [
      profile("ambient", "ambient"),
    ]);
    const envKey: ProviderCliState = {
      ...provider("codex", []),
      apiKey: { supported: true, configured: true, source: "env" },
    };
    const calls = renderGroup(
      {
        ...NOTHING,
        providers: [ambientOnly, envKey],
        secrets: [secret({ revoked: true })],
      },
      "settings",
    );

    await waitFor(() => {
      expect(calls.providers).toBeGreaterThan(0);
      expect(calls.secrets).toBeGreaterThan(0);
    });
    await settle();
    expect(marks()).toEqual(["provider=false", "secret=false", "agents=false"]);
    expect(progress()).toBe("0 of 3 done");
  });

  it("does not read secrets from a host that does not have environment.secrets.list", async () => {
    const calls = renderGroup(
      {
        ...NOTHING,
        secrets: [secret({})],
        providers: [storedKey()],
        methods: ["environment.status", "providers.list"],
      },
      "settings",
    );

    await waitFor(() => {
      expect(progress()).toBe("1 of 3 done");
    });
    await settle();
    expect(calls.secrets).toBe(0);
    expect(marks()).toEqual(["provider=true", "secret=false", "agents=false"]);
  });

  it("keeps the agents step open on a host that cannot answer environment.status", async () => {
    const calls = renderGroup(
      {
        ...NOTHING,
        providers: [storedKey()],
        status: guideStatus(),
        methods: ["providers.list", "environment.secrets.list"],
      },
      "settings",
    );

    await waitFor(() => {
      expect(progress()).toBe("1 of 3 done");
    });
    await settle();
    expect(calls.status).toBe(0);
    expect(marks()).toEqual(["provider=true", "secret=false", "agents=false"]);
  });

  it("re-reads secrets and providers when the host reports a new settings revision, as when a step is done in the dashboard", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const facts: {
        providers: ProviderCliState[];
        secrets: EnvironmentSecret[];
        status: EnvironmentStatusResponseV11;
        methods: readonly string[];
      } = {
        providers: [],
        secrets: [],
        status: environmentStatusFixture({
          receivedRevision: 1,
          appliedRevision: 1,
        }),
        methods: ALL_METHODS,
      };
      const calls = renderGroup(facts, "settings");

      await waitFor(() => {
        expect(calls.status).toBeGreaterThan(0);
        expect(calls.secrets).toBeGreaterThan(0);
        expect(calls.providers).toBeGreaterThan(0);
      });
      await waitFor(() => {
        expect(progress()).toBe("0 of 3 done");
      });
      const statusReadsBefore = calls.status;

      // The person finishes two steps in the dashboard: the host's settings
      // move to revision 2 and its secrets and providers change with them.
      facts.status = environmentStatusFixture({
        receivedRevision: 2,
        appliedRevision: 2,
      });
      facts.secrets = [secret({})];
      facts.providers = [storedKey()];

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });

      // The 5 s status poll fired again.
      expect(calls.status).toBeGreaterThan(statusReadsBefore);
      let received = progress();
      try {
        await waitFor(() => {
          received = progress();
          expect(received).toBe("2 of 3 done");
        });
      } catch (error) {
        throw new Error(
          `progress stayed "${received}" after the status poll (status reads: ${calls.status}, secrets reads: ${calls.secrets}, providers reads: ${calls.providers}); ${String(error)}`,
        );
      }
      expect(marks()).toEqual(["provider=true", "secret=true", "agents=false"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the page each step names", () => {
    renderGroup(NOTHING, "settings");

    fireEvent.click(screen.getByRole("button", { name: "Open Providers" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Secrets" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Open Agent selection" }),
    );

    expect(navigateMock.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      "providers",
      "secrets",
      "agents",
    ]);
  });

  it("renders with no host runtime: every step open, no throw, and Open still works", async () => {
    hostMock.client = null;
    hostMock.hostId = null;
    mount("home");

    await settle();
    expect(marks()).toEqual(["provider=false", "secret=false", "agents=false"]);
    expect(progress()).toBe("0 of 3 done");
    fireEvent.click(screen.getByRole("button", { name: "Open Secrets" }));
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock.mock.calls[0]?.[0]).toBe("secrets");
  });
});
