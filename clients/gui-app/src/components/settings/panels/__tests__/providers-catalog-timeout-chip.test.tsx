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
import type { ConfigCatalogResponse } from "@traycer/protocol/host/config/schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The Model list timeout CHIP: its gate (absent, not inert), what it states,
 * and its one write. RPCs run for real against a `MockHostMessenger`; only the
 * per-host FACTS (reachability, whether each method was advertised) are
 * mocked. The dropdown is the REAL Radix one.
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

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "config.catalog.set" ? state.supportedSet : state.supportedGet,
  useHostSupportsMethod: () => state.supportedGet === true,
  useHostMethodSchemaVersion: () => null,
}));

vi.mock("@/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics")>()),
  trackSettingChanged: (...args: ReadonlyArray<unknown>) => {
    tracked(...args);
  },
}));

import { ProvidersCatalogTimeoutChip } from "@/components/settings/panels/providers-catalog-timeout-chip";
import { catalogTimeoutOptions } from "@/components/settings/panels/providers-catalog-timeout-options";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";

const HOST_A = { hostId: "host-a", name: "Host A" };
const DEFAULT_BOUNDS = { minSeconds: 60, maxSeconds: 180 };

interface Harness {
  readonly client: HostClient<HostRpcRegistry>;
  readonly gets: () => number;
  readonly sets: () => ReadonlyArray<number>;
  readonly addressed: () => ReadonlyArray<string>;
}

interface HarnessOptions {
  readonly initial: number;
  readonly bounds: { readonly minSeconds: number; readonly maxSeconds: number };
  readonly failReads: boolean;
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
  const sets: number[] = [];
  const addressed: string[] = [];
  const messenger: MockHostMessenger<HostRpcRegistry> =
    new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${Math.random().toString(36).slice(2)}`,
      handlers: {
        "config.catalog.get": () => {
          getCount += 1;
          addressed.push(
            messenger.calls.at(-1)?.authority.endpoint.hostId ?? "",
          );
          if (options.failReads) {
            return Promise.reject(new Error("config.json is garbage"));
          }
          return Promise.resolve({
            probeTimeoutSeconds: stored,
            bounds: options.bounds,
          });
        },
        "config.catalog.set": (params) => {
          sets.push(params.probeTimeoutSeconds);
          addressed.push(
            messenger.calls.at(-1)?.authority.endpoint.hostId ?? "",
          );
          stored = params.probeTimeoutSeconds;
          return Promise.resolve({
            probeTimeoutSeconds: stored,
            bounds: options.bounds,
          });
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

function defaultOptions(initial: number): HarnessOptions {
  return {
    initial,
    bounds: DEFAULT_BOUNDS,
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
    <ProvidersCatalogTimeoutChip
      scope={hostScopeFixture({
        host: hostScopeOptionFixture(HOST_A),
        client,
      })}
    />,
    { wrapper: Wrapper },
  );
}

function renderReady(initial: number): Harness {
  const { harness, queryClient } = createHarness(defaultOptions(initial));
  renderChip(harness.client, queryClient);
  return harness;
}

function chip(): HTMLElement {
  return screen.getByTestId("providers-catalog-timeout-chip");
}

async function openMenu(): Promise<void> {
  fireEvent.pointerDown(chip(), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  await screen.findByTestId("providers-catalog-timeout-menu");
}

function radio(label: string): HTMLElement {
  const match = screen
    .getAllByRole("menuitemradio")
    .find((item) => item.textContent.startsWith(label));
  if (match === undefined) throw new Error(`no radio starting with ${label}`);
  return match;
}

function radioLabels(): ReadonlyArray<string> {
  return screen.getAllByRole("menuitemradio").map((item) => item.textContent);
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

describe("ProvidersCatalogTimeoutChip gate", () => {
  it("renders nothing when config.catalog.get is not negotiated", () => {
    state.supportedGet = false;
    const { harness, queryClient } = createHarness(defaultOptions(60));
    const { container } = renderChip(harness.client, queryClient);
    expect(container.querySelector("[data-testid]")).toBeNull();
    expect(harness.gets()).toBe(0);
  });

  it("renders nothing when config.catalog.set is not negotiated", () => {
    state.supportedSet = false;
    const { harness, queryClient } = createHarness(defaultOptions(60));
    const { container } = renderChip(harness.client, queryClient);
    expect(container.querySelector("[data-testid]")).toBeNull();
    expect(harness.gets()).toBe(0);
  });

  it("renders nothing while no handshake has answered", () => {
    state.supportedGet = null;
    state.supportedSet = null;
    const { harness, queryClient } = createHarness(defaultOptions(60));
    const { container } = renderChip(harness.client, queryClient);
    expect(container.querySelector("[data-testid]")).toBeNull();
    expect(harness.gets()).toBe(0);
  });

  it("renders nothing when the host is offline", () => {
    state.reachability = { status: "unreachable", hostLabel: "Host A" };
    const { harness, queryClient } = createHarness(defaultOptions(60));
    const { container } = renderChip(harness.client, queryClient);
    expect(container.querySelector("[data-testid]")).toBeNull();
    expect(harness.gets()).toBe(0);
  });
});

describe("ProvidersCatalogTimeoutChip ready", () => {
  it("states the host's value in the chip", async () => {
    renderReady(60);
    await waitFor(() => {
      expect(chip().textContent).toBe("Model list timeout · 60 s");
    });
    expect(chip().getAttribute("data-seconds")).toBe("60");
  });

  it("claims no value until the read lands", () => {
    renderReady(120);
    expect(chip().textContent).toBe("Model list timeout");
    expect(chip().getAttribute("data-seconds")).toBeNull();
  });

  it("checks the current value and offers the four presets", async () => {
    renderReady(90);
    await waitFor(() => {
      expect(chip().textContent).toBe("Model list timeout · 90 s");
    });
    await openMenu();
    await waitFor(() => {
      expect(radio("90 s").getAttribute("aria-checked")).toBe("true");
    });
    expect(radioLabels()).toEqual(["60 s", "90 s", "120 s", "180 s"]);
    expect(radio("60 s").getAttribute("aria-checked")).toBe("false");
    expect(radio("120 s").getAttribute("aria-checked")).toBe("false");
    expect(radio("180 s").getAttribute("aria-checked")).toBe("false");
  });

  it("writes the picked value on the scope's client, then shows the re-read value", async () => {
    const { harness, queryClient } = createHarness({
      ...defaultOptions(60),
      host: mockRemoteHostEntry,
    });
    renderChip(harness.client, queryClient);
    await waitFor(() => {
      expect(chip().textContent).toBe("Model list timeout · 60 s");
    });
    const readsBefore = harness.gets();

    await openMenu();
    await waitFor(() => {
      expect(isDisabled(radio("120 s"))).toBe(false);
    });
    fireEvent.click(radio("120 s"));

    await waitFor(() => {
      expect(chip().textContent).toBe("Model list timeout · 120 s");
    });
    expect(harness.sets()).toEqual([120]);
    expect(harness.gets()).toBeGreaterThan(readsBefore);
    expect(new Set(harness.addressed())).toEqual(
      new Set([mockRemoteHostEntry.hostId]),
    );
    expect(tracked).toHaveBeenCalledTimes(1);
    expect(tracked).toHaveBeenCalledWith("providers", "catalogProbeTimeout");
  });

  it("writes nothing when the current value is picked again", async () => {
    const harness = renderReady(90);
    await waitFor(() => {
      expect(chip().textContent).toBe("Model list timeout · 90 s");
    });
    await openMenu();
    await waitFor(() => {
      expect(isDisabled(radio("90 s"))).toBe(false);
    });
    fireEvent.click(radio("90 s"));

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(harness.sets()).toEqual([]);
    expect(tracked).not.toHaveBeenCalled();
  });

  it("replaces the choices with the repair sentence when the read fails", async () => {
    const { harness, queryClient } = createHarness({
      ...defaultOptions(60),
      failReads: true,
    });
    renderChip(harness.client, queryClient);

    await openMenu();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't read this host's setting");
    expect(alert.textContent).toContain("~/.traycer/cli/config.json");
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(chip().textContent).toBe("Model list timeout");
    expect(harness.sets()).toEqual([]);
  });

  it("shows a hand-edited value as a selected custom row", async () => {
    renderReady(75);
    await waitFor(() => {
      expect(chip().textContent).toBe("Model list timeout · 75 s");
    });
    await openMenu();
    await waitFor(() => {
      expect(radio("75 s (custom)").getAttribute("aria-checked")).toBe("true");
    });
    expect(radioLabels()).toEqual([
      "60 s",
      "75 s (custom)",
      "90 s",
      "120 s",
      "180 s",
    ]);
  });

  it("does not offer a preset below the host's minimum", async () => {
    const { harness, queryClient } = createHarness({
      ...defaultOptions(120),
      bounds: { minSeconds: 90, maxSeconds: 180 },
    });
    renderChip(harness.client, queryClient);
    await waitFor(() => {
      expect(chip().textContent).toBe("Model list timeout · 120 s");
    });
    await openMenu();
    await waitFor(() => {
      expect(radio("120 s").getAttribute("aria-checked")).toBe("true");
    });
    expect(radioLabels()).toEqual(["90 s", "120 s", "180 s"]);
  });
});

describe("catalogTimeoutOptions", () => {
  function response(
    probeTimeoutSeconds: number,
    minSeconds: number,
    maxSeconds: number,
  ): ConfigCatalogResponse {
    return { probeTimeoutSeconds, bounds: { minSeconds, maxSeconds } };
  }

  it("offers the four presets before the host has answered", () => {
    expect(catalogTimeoutOptions(null)).toEqual([
      { seconds: 60, label: "60 s" },
      { seconds: 90, label: "90 s" },
      { seconds: 120, label: "120 s" },
      { seconds: 180, label: "180 s" },
    ]);
  });

  it("returns exactly the presets when the value is one of them", () => {
    expect(catalogTimeoutOptions(response(120, 60, 180))).toEqual([
      { seconds: 60, label: "60 s" },
      { seconds: 90, label: "90 s" },
      { seconds: 120, label: "120 s" },
      { seconds: 180, label: "180 s" },
    ]);
  });

  it("filters the presets to the host's bounds, inclusive", () => {
    expect(
      catalogTimeoutOptions(response(120, 90, 120)).map((o) => o.seconds),
    ).toEqual([90, 120]);
  });

  it("inserts a stored off-preset value as a labelled custom row in order", () => {
    expect(catalogTimeoutOptions(response(75, 60, 180))).toEqual([
      { seconds: 60, label: "60 s" },
      { seconds: 75, label: "75 s (custom)" },
      { seconds: 90, label: "90 s" },
      { seconds: 120, label: "120 s" },
      { seconds: 180, label: "180 s" },
    ]);
  });

  it("keeps an out-of-bounds stored value visible as custom", () => {
    expect(catalogTimeoutOptions(response(30, 60, 180))[0]).toEqual({
      seconds: 30,
      label: "30 s (custom)",
    });
  });
});
