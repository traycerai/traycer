import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { AgentWorktreeCreatePolicy } from "@traycer/protocol/config/schema";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The agent-worktrees CHIP: its gate ladder, what it states, and its one write.
 *
 * It is modelled on `worktree-auto-cleanup-chip.test.tsx` (same gate, same
 * inert chip) and on the browser access row's test (two methods that negotiate
 * independently). The RPCs run for real against a `MockHostMessenger`, so the
 * read, the write and the re-read go through the actual query/mutation path.
 * Only the two per-host FACTS the chip cannot synthesize - reachability and
 * whether this host advertised each method - are mocked. The dropdown is the
 * REAL Radix one: a passthrough stand-in cannot say which radio is checked.
 */
const state = vi.hoisted(
  (): {
    reachability: { status: string; hostLabel: string };
    supportedGet: boolean | null;
    supportedSet: boolean | null;
  } => ({
    reachability: { status: "reachable", hostLabel: "Host A" },
    supportedGet: true,
    supportedSet: true,
  }),
);
const tracked = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => state.reachability,
}));

// The two methods negotiate independently, so the mock answers per method.
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "config.worktrees.set" ? state.supportedSet : state.supportedGet,
  useHostSupportsMethod: () => state.supportedGet === true,
  useHostMethodSchemaVersion: () => null,
}));

vi.mock("@/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics")>()),
  trackSettingChanged: (...args: ReadonlyArray<unknown>) => {
    tracked(...args);
  },
}));

import { WorktreeAgentCreateChip } from "@/components/settings/panels/worktree-agent-create-chip";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";

const HOST_A = { hostId: "host-a", name: "Host A" };

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface Harness {
  readonly client: HostClient<HostRpcRegistry>;
  readonly gets: () => number;
  /** Every `config.worktrees.set` request body, in order. */
  readonly sets: () => ReadonlyArray<AgentWorktreeCreatePolicy>;
  /** The host each request was ADDRESSED to, read off the recorded call. */
  readonly addressed: () => ReadonlyArray<string>;
}

interface HarnessOptions {
  readonly initial: AgentWorktreeCreatePolicy;
  /** While non-null, `config.worktrees.get` does not answer until it settles. */
  readonly holdGet: Deferred | null;
  /** While non-null, `config.worktrees.set` does not answer until it settles. */
  readonly holdSet: Deferred | null;
  readonly failReads: boolean;
  /** The host the returned client is pinned to. */
  readonly host: typeof mockLocalHostEntry;
}

function createHarness(options: HarnessOptions): {
  readonly harness: Harness;
  readonly queryClient: QueryClient;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let stored = options.initial;
  let getCount = 0;
  const sets: AgentWorktreeCreatePolicy[] = [];
  const addressed: string[] = [];
  const messenger: MockHostMessenger<HostRpcRegistry> =
    new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${Math.random().toString(36).slice(2)}`,
      handlers: {
        "config.worktrees.get": async () => {
          getCount += 1;
          addressed.push(
            messenger.calls.at(-1)?.authority.endpoint.hostId ?? "",
          );
          if (options.holdGet !== null) await options.holdGet.promise;
          if (options.failReads) throw new Error("config.json is garbage");
          return { agentCreate: stored };
        },
        "config.worktrees.set": async (params) => {
          sets.push(params.agentCreate);
          addressed.push(
            messenger.calls.at(-1)?.authority.endpoint.hostId ?? "",
          );
          if (options.holdSet !== null) await options.holdSet.promise;
          stored = params.agentCreate;
          return { agentCreate: stored };
        },
      },
    });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
    findHostById: (hostId) => {
      if (hostId === mockLocalHostEntry.hostId) return mockLocalHostEntry;
      if (hostId === mockRemoteHostEntry.hostId) return mockRemoteHostEntry;
      return null;
    },
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return {
    harness: {
      client: spine.createRequester(options.host),
      gets: () => getCount,
      sets: () => sets,
      addressed: () => addressed,
    },
    queryClient,
  };
}

function defaultOptions(initial: AgentWorktreeCreatePolicy): HarnessOptions {
  return {
    initial,
    holdGet: null,
    holdSet: null,
    failReads: false,
    host: mockLocalHostEntry,
  };
}

function renderChip(
  client: HostClient<HostRpcRegistry> | null,
  queryClient: QueryClient,
): RenderResult {
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>{props.children}</TooltipProvider>
    </QueryClientProvider>
  );
  return render(
    <WorktreeAgentCreateChip
      scope={hostScopeFixture({
        host: hostScopeOptionFixture(HOST_A),
        client,
      })}
    />,
    { wrapper: Wrapper },
  );
}

function renderReady(initial: AgentWorktreeCreatePolicy): Harness {
  const { harness, queryClient } = createHarness(defaultOptions(initial));
  renderChip(harness.client, queryClient);
  return harness;
}

function chip(): HTMLElement {
  return screen.getByTestId("worktree-agent-create-chip");
}

/**
 * Radix opens a dropdown on pointerdown, not click - firing only `click` leaves
 * the menu shut and every query after it passing vacuously.
 */
async function openMenu(): Promise<void> {
  fireEvent.pointerDown(chip(), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  await screen.findByTestId("worktree-agent-create-menu");
}

function radio(label: string): HTMLElement {
  const match = screen
    .getAllByRole("menuitemradio")
    .find((item) => item.textContent.startsWith(label));
  if (match === undefined) throw new Error(`no radio starting with ${label}`);
  return match;
}

function isDisabled(item: HTMLElement): boolean {
  return item.getAttribute("aria-disabled") === "true";
}

beforeEach(() => {
  state.reachability = { status: "reachable", hostLabel: "Host A" };
  state.supportedGet = true;
  state.supportedSet = true;
  tracked.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WorktreeAgentCreateChip gate", () => {
  it("says the host is too old in a tooltip rather than offering controls", async () => {
    state.supportedGet = false;
    state.supportedSet = false;
    const { harness, queryClient } = createHarness(defaultOptions("allow"));
    renderChip(harness.client, queryClient);

    expect(chip().getAttribute("data-gate")).toBe("unsupported");
    expect(chip().getAttribute("aria-disabled")).toBe("true");
    expect(chip().textContent).toBe("Agent worktrees");
    fireEvent.pointerMove(chip());
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain(
      "Host A is running a version without",
    );
    expect(tooltip.textContent).toContain("Update the host");

    // Inert: pressing it opens no menu, and nothing is asked of the host.
    fireEvent.pointerDown(chip(), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(chip());
    expect(screen.queryByTestId("worktree-agent-create-menu")).toBeNull();
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(harness.gets()).toBe(0);
  });

  it("is inert when the host can read the policy but not write it", () => {
    // A menu whose every choice fails is worse than no menu: the two methods
    // degrade independently, so the gate demands both.
    state.supportedGet = true;
    state.supportedSet = false;
    const { harness, queryClient } = createHarness(defaultOptions("allow"));
    renderChip(harness.client, queryClient);

    expect(chip().getAttribute("data-gate")).toBe("unsupported");
    expect(chip().getAttribute("aria-disabled")).toBe("true");
    expect(harness.gets()).toBe(0);
  });

  it("is inert when the host can write the policy but not read it", () => {
    state.supportedGet = false;
    state.supportedSet = true;
    const { harness, queryClient } = createHarness(defaultOptions("allow"));
    renderChip(harness.client, queryClient);

    expect(chip().getAttribute("data-gate")).toBe("unsupported");
    expect(harness.gets()).toBe(0);
  });

  it("says it is checking while no handshake has answered for either method", async () => {
    state.supportedGet = null;
    state.supportedSet = null;
    const { harness, queryClient } = createHarness(defaultOptions("allow"));
    renderChip(harness.client, queryClient);

    expect(chip().getAttribute("data-gate")).toBe("checking");
    expect(chip().getAttribute("aria-disabled")).toBe("true");
    fireEvent.pointerMove(chip());
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Checking whether Host A supports");
    expect(tooltip.textContent).not.toContain("Update the host");
    expect(harness.gets()).toBe(0);
  });

  it("keeps checking while only one method has answered", () => {
    // `null` is "no handshake yet", never "absent": telling someone their host
    // is too old because one answer is still in flight is a claim about a fact
    // not in evidence.
    state.supportedGet = true;
    state.supportedSet = null;
    const { harness, queryClient } = createHarness(defaultOptions("allow"));
    renderChip(harness.client, queryClient);
    expect(chip().getAttribute("data-gate")).toBe("checking");
    cleanup();

    state.supportedGet = null;
    state.supportedSet = true;
    renderChip(harness.client, queryClient);
    expect(chip().getAttribute("data-gate")).toBe("checking");
  });

  it("explains an offline host without claiming its version is the problem", async () => {
    state.reachability = { status: "unreachable", hostLabel: "Host A" };
    const { queryClient } = createHarness(defaultOptions("allow"));
    renderChip(null, queryClient);

    expect(chip().getAttribute("data-gate")).toBe("offline");
    fireEvent.pointerMove(chip());
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Host A is offline");
    expect(tooltip.textContent).not.toContain("Update the host");
  });

  it("renders nothing at all without a resolved host", () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider delayDuration={0}>
          <WorktreeAgentCreateChip
            scope={hostScopeFixture({ host: null, client: null })}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    // The inventory's own `HostScopeGate` names that state; a second copy of
    // it in the toolbar would be two answers to one question.
    expect(container.querySelector("[data-testid]")).toBeNull();
  });
});

describe("WorktreeAgentCreateChip ready", () => {
  it("claims no policy until the read lands", async () => {
    // Asserted on the FIRST paint, before the read resolves: the chip must not
    // paint "Allow" - which is a real policy - for one it has not been told.
    const { harness, queryClient } = createHarness({
      ...defaultOptions("ask"),
      holdGet: deferred(),
    });
    renderChip(harness.client, queryClient);

    expect(chip().textContent).toBe("Agent worktrees");
    expect(chip().getAttribute("data-policy")).toBeNull();
    expect(chip().getAttribute("aria-disabled")).toBeNull();
    expect(chip().getAttribute("data-gate")).toBeNull();

    // Every choice stays disabled until the read lands, so nothing is chosen
    // against an unknown current value.
    await openMenu();
    const radios = screen.getAllByRole("menuitemradio");
    expect(radios).toHaveLength(3);
    for (const item of radios) expect(isDisabled(item)).toBe(true);
    for (const item of radios) {
      expect(item.getAttribute("aria-checked")).toBe("false");
    }
  });

  it("states the policy in the chip, for each of the three values", async () => {
    for (const [policy, label] of [
      ["allow", "Agent worktrees · Allow"],
      ["ask", "Agent worktrees · Ask first"],
      ["never", "Agent worktrees · Never"],
    ] as const) {
      renderReady(policy);
      await waitFor(() => {
        expect(chip().textContent).toBe(label);
      });
      expect(chip().getAttribute("data-policy")).toBe(policy);
      cleanup();
    }
  });

  it("checks the current value in the menu and names the host it governs", async () => {
    renderReady("ask");
    await waitFor(() => {
      expect(chip().textContent).toBe("Agent worktrees · Ask first");
    });
    await openMenu();

    await waitFor(() => {
      expect(radio("Ask first").getAttribute("aria-checked")).toBe("true");
    });
    expect(radio("Allow").getAttribute("aria-checked")).toBe("false");
    expect(radio("Never").getAttribute("aria-checked")).toBe("false");
    for (const label of ["Allow", "Ask first", "Never"]) {
      expect(isDisabled(radio(label))).toBe(false);
    }
    expect(
      screen.getByTestId("worktree-agent-create-menu").textContent,
    ).toContain("Applies to agents running on Host A");
  });

  it("issues config.worktrees.set with the chosen value on the scope's client", async () => {
    // The scope's client is the REMOTE host's: the request must be addressed to
    // it, not to whatever the app happens to be focused on.
    const { harness, queryClient } = createHarness({
      ...defaultOptions("allow"),
      host: mockRemoteHostEntry,
    });
    renderChip(harness.client, queryClient);
    await waitFor(() => {
      expect(chip().textContent).toBe("Agent worktrees · Allow");
    });

    await openMenu();
    await waitFor(() => {
      expect(isDisabled(radio("Never"))).toBe(false);
    });
    fireEvent.click(radio("Never"));

    await waitFor(() => {
      expect(harness.sets()).toEqual(["never"]);
    });
    expect(new Set(harness.addressed())).toEqual(
      new Set([mockRemoteHostEntry.hostId]),
    );
    expect(tracked).toHaveBeenCalledTimes(1);
    expect(tracked).toHaveBeenCalledWith("worktrees", "agentWorktreeCreate");
  });

  it("re-reads after a write, so the chip states what the host answers", async () => {
    const harness = renderReady("allow");
    await waitFor(() => {
      expect(chip().textContent).toBe("Agent worktrees · Allow");
    });
    const readsBefore = harness.gets();

    await openMenu();
    await waitFor(() => {
      expect(isDisabled(radio("Ask first"))).toBe(false);
    });
    fireEvent.click(radio("Ask first"));

    await waitFor(() => {
      expect(chip().textContent).toBe("Agent worktrees · Ask first");
    });
    expect(harness.sets()).toEqual(["ask"]);
    expect(harness.gets()).toBeGreaterThan(readsBefore);
  });

  it("issues nothing when the current value is chosen again", async () => {
    const harness = renderReady("ask");
    await waitFor(() => {
      expect(chip().textContent).toBe("Agent worktrees · Ask first");
    });

    await openMenu();
    await waitFor(() => {
      expect(isDisabled(radio("Ask first"))).toBe(false);
    });
    fireEvent.click(radio("Ask first"));

    // Settle the effects and the task a request would land on before a
    // negative assertion: `waitFor` passes on its first check.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(harness.sets()).toEqual([]);
    expect(tracked).not.toHaveBeenCalled();
  });

  it("locks the choices and shows saving while a write is in flight", async () => {
    const holdSet = deferred();
    const { harness, queryClient } = createHarness({
      ...defaultOptions("allow"),
      holdSet,
    });
    renderChip(harness.client, queryClient);
    await waitFor(() => {
      expect(chip().textContent).toBe("Agent worktrees · Allow");
    });

    await openMenu();
    await waitFor(() => {
      expect(isDisabled(radio("Never"))).toBe(false);
    });
    fireEvent.click(radio("Never"));

    await screen.findByTestId("worktree-agent-create-saving");
    // Radix closes the menu on select; reopen it to read the choices.
    if (screen.queryByTestId("worktree-agent-create-menu") === null) {
      await openMenu();
    }
    await waitFor(() => {
      expect(isDisabled(radio("Allow"))).toBe(true);
    });
    expect(isDisabled(radio("Ask first"))).toBe(true);
    // The chip keeps stating the last value the host answered, not the one it
    // was asked to write. (The saving spinner's glyph trails the label.)
    expect(chip().textContent).toContain("Agent worktrees · Allow");
    expect(chip().textContent).not.toContain("Never");
    expect(chip().getAttribute("data-policy")).toBe("allow");

    holdSet.resolve();
    await waitFor(() => {
      expect(chip().textContent).toBe("Agent worktrees · Never");
    });
    await waitFor(() => {
      expect(screen.queryByTestId("worktree-agent-create-saving")).toBeNull();
    });
    expect(harness.sets()).toEqual(["never"]);
  });

  it("replaces the choices with the repair sentence when the read fails", async () => {
    // A malformed config file makes `config.worktrees.get` throw, so the chip
    // shows an error rather than a false "Allow". The chip itself stays live:
    // a read that failed is not a host that cannot do this.
    const { harness, queryClient } = createHarness({
      ...defaultOptions("allow"),
      failReads: true,
    });
    renderChip(harness.client, queryClient);

    expect(chip().getAttribute("aria-disabled")).toBeNull();
    await openMenu();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't read this host's setting");
    expect(alert.textContent).toContain("~/.traycer/cli/config.json");
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(chip().textContent).toBe("Agent worktrees");
    expect(harness.sets()).toEqual([]);
  });
});
