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
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  ConfigCatalogResponse,
  ConfigCatalogSetRequest,
} from "@traycer/protocol/host/config/schemas";
import type { NegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The per-provider Model list timeout rows: their gate (absent, not inert),
 * what they state, and the exact bodies they write. RPCs run for real against
 * a `MockHostMessenger`; only the per-host FACTS (reachability, the version
 * each method negotiated, the ambient client) are mocked.
 */
const state = vi.hoisted(
  (): {
    reachability: { status: string; hostLabel: string };
    getVersion: unknown;
    setVersion: unknown;
    client: unknown;
  } => ({
    reachability: { status: "reachable", hostLabel: "Host A" },
    getVersion: null,
    setVersion: null,
    client: null,
  }),
);
const tracked = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => state.reachability,
}));

vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersion: (_client: unknown, method: string) =>
    method === "config.catalog.set" ? state.setVersion : state.getVersion,
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => state.client,
}));

vi.mock("@/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics")>()),
  trackSettingChanged: (...args: ReadonlyArray<unknown>) => {
    tracked(...args);
  },
}));

import { ProviderCatalogTimeoutGroup } from "@/components/settings/panels/provider-catalog-timeout-group";
import {
  catalogTimeoutOptions,
  catalogTimeoutRowsSupported,
} from "@/components/settings/panels/providers-catalog-timeout-options";

const HOST_ID = "host-a";
const DEFAULT_BOUNDS = { minSeconds: 60, maxSeconds: 180 };
const V10 = { major: 1, minor: 0 } as const;
const V11 = { major: 1, minor: 1 } as const;

interface Harness {
  readonly sets: ReadonlyArray<ConfigCatalogSetRequest>;
  readonly gets: () => number;
}

interface HarnessOptions {
  readonly shared: number;
  readonly overrides: Record<string, number>;
  readonly failReads: boolean;
}

function mountHarness(options: HarnessOptions): {
  readonly harness: Harness;
  readonly queryClient: QueryClient;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let shared = options.shared;
  let overrides: Record<string, number> = { ...options.overrides };
  let getCount = 0;
  const sets: ConfigCatalogSetRequest[] = [];
  const read = (): ConfigCatalogResponse => ({
    probeTimeoutSeconds: shared,
    overrides: { ...overrides },
    bounds: DEFAULT_BOUNDS,
  });
  const messenger: MockHostMessenger<HostRpcRegistry> =
    new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${Math.random().toString(36).slice(2)}`,
      handlers: {
        "config.catalog.get": () => {
          getCount += 1;
          if (options.failReads) {
            return Promise.reject(new Error("config.json is garbage"));
          }
          return Promise.resolve(read());
        },
        "config.catalog.set": (params) => {
          sets.push(params);
          if (params.scope === "all") {
            shared = params.probeTimeoutSeconds;
          } else {
            const next: Record<string, number> = {};
            for (const [key, value] of Object.entries(overrides)) {
              if (key !== params.harnessId) next[key] = value;
            }
            if (params.probeTimeoutSeconds !== null) {
              next[params.harnessId] = params.probeTimeoutSeconds;
            }
            overrides = next;
          }
          return Promise.resolve(read());
        },
      },
    });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  state.client = spine.createRequester(mockLocalHostEntry);
  return { harness: { sets, gets: () => getCount }, queryClient };
}

function defaults(
  shared: number,
  overrides: Record<string, number>,
): HarnessOptions {
  return { shared, overrides, failReads: false };
}

function renderGroup(queryClient: QueryClient): RenderResult {
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>{props.children}</TooltipProvider>
    </QueryClientProvider>
  );
  return render(
    <ProviderCatalogTimeoutGroup providerId="claude-code" hostId={HOST_ID} />,
    { wrapper: Wrapper },
  );
}

function renderReady(options: HarnessOptions): Harness {
  const { harness, queryClient } = mountHarness(options);
  renderGroup(queryClient);
  return harness;
}

function picker(): HTMLElement {
  return screen.getByRole("group", { name: "Model list timeout" });
}

function segment(label: string): HTMLElement {
  const match = Array.from(picker().querySelectorAll("button")).find(
    (button) => button.textContent === label,
  );
  if (match === undefined) throw new Error(`no segment ${label}`);
  return match;
}

function segmentLabels(): ReadonlyArray<string> {
  return Array.from(picker().querySelectorAll("button")).map(
    (button) => button.textContent,
  );
}

function pressedLabels(): ReadonlyArray<string> {
  return Array.from(picker().querySelectorAll("button"))
    .filter((button) => button.getAttribute("aria-pressed") === "true")
    .map((button) => button.textContent);
}

function sameForAllSwitch(): HTMLElement {
  return screen.getByRole("switch", { name: "Same for all providers" });
}

async function settled(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 20);
  });
}

beforeEach(() => {
  state.reachability = { status: "reachable", hostLabel: "Host A" };
  state.getVersion = V11;
  state.setVersion = V11;
  state.client = null;
  tracked.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ProviderCatalogTimeoutGroup gate", () => {
  const unreadable: ReadonlyArray<
    readonly [string, NegotiatedMethodVersion, NegotiatedMethodVersion]
  > = [
    ["get is at 1.0", V10, V11],
    ["set is at 1.0", V11, V10],
    ["both are at 1.0", V10, V10],
    ["get is absent", false, V11],
    ["set is absent", V11, false],
    ["get is unknown", null, V11],
    ["set is unknown", V11, null],
    ["both are unknown", null, null],
  ];

  for (const [name, get, set] of unreadable) {
    it(`renders nothing and reads nothing when ${name}`, () => {
      state.getVersion = get;
      state.setVersion = set;
      const { harness, queryClient } = mountHarness(defaults(60, {}));
      const { container } = renderGroup(queryClient);
      expect(container.childElementCount).toBe(0);
      expect(screen.queryByText("Model list")).toBeNull();
      expect(harness.gets()).toBe(0);
    });
  }

  it("renders nothing when the host is offline", () => {
    state.reachability = { status: "unreachable", hostLabel: "Host A" };
    const { harness, queryClient } = mountHarness(defaults(60, {}));
    const { container } = renderGroup(queryClient);
    expect(container.childElementCount).toBe(0);
    expect(harness.gets()).toBe(0);
  });
});

describe("ProviderCatalogTimeoutGroup rows", () => {
  it("renders the Model list group with its two rows and four segments when both methods are at 1.1", async () => {
    renderReady(defaults(60, {}));

    expect(screen.getByText("Model list")).toBeTruthy();
    expect(screen.getByText("Timeout")).toBeTruthy();
    expect(
      screen.getByText("How long to wait for the model list."),
    ).toBeTruthy();
    expect(screen.getByText("Same for all providers")).toBeTruthy();
    await waitFor(() => {
      expect(pressedLabels()).toEqual(["60 s"]);
    });
    expect(segmentLabels()).toEqual(["60 s", "90 s", "120 s", "180 s"]);
  });

  it("with no override for claude: the switch is on, the shared value is pressed, and a pick writes scope all then shows the re-read value", async () => {
    const harness = renderReady(defaults(90, {}));
    await waitFor(() => {
      expect(pressedLabels()).toEqual(["90 s"]);
    });
    expect(sameForAllSwitch().getAttribute("aria-checked")).toBe("true");
    const readsBefore = harness.gets();

    fireEvent.click(segment("120 s"));

    await waitFor(() => {
      expect(pressedLabels()).toEqual(["120 s"]);
    });
    expect(harness.sets).toEqual([{ scope: "all", probeTimeoutSeconds: 120 }]);
    expect(harness.gets()).toBeGreaterThan(readsBefore);
    expect(tracked).toHaveBeenCalledTimes(1);
    expect(tracked).toHaveBeenCalledWith("providers", "catalogProbeTimeout");
  });

  it("with overrides {claude: 90}: the switch is off, 90 s is pressed, and a pick writes scope harness for claude", async () => {
    const harness = renderReady(defaults(60, { claude: 90 }));
    await waitFor(() => {
      expect(pressedLabels()).toEqual(["90 s"]);
    });
    expect(sameForAllSwitch().getAttribute("aria-checked")).toBe("false");

    fireEvent.click(segment("180 s"));

    await waitFor(() => {
      expect(pressedLabels()).toEqual(["180 s"]);
    });
    expect(harness.sets).toEqual([
      { scope: "harness", harnessId: "claude", probeTimeoutSeconds: 180 },
    ]);
    expect(tracked).toHaveBeenCalledWith("providers", "catalogProbeTimeout");
  });

  it("another provider's override does not take this provider off the shared value", async () => {
    const harness = renderReady(defaults(75, { codex: 120 }));
    await waitFor(() => {
      expect(pressedLabels()).toEqual(["75 s"]);
    });
    expect(sameForAllSwitch().getAttribute("aria-checked")).toBe("true");

    fireEvent.click(segment("60 s"));

    await waitFor(() => {
      expect(harness.sets).toEqual([{ scope: "all", probeTimeoutSeconds: 60 }]);
    });
  });

  it("turning the switch off writes this provider's own value, starting at the shared one", async () => {
    const harness = renderReady(defaults(120, {}));
    await waitFor(() => {
      expect(pressedLabels()).toEqual(["120 s"]);
    });

    fireEvent.click(sameForAllSwitch());

    await waitFor(() => {
      expect(sameForAllSwitch().getAttribute("aria-checked")).toBe("false");
    });
    expect(harness.sets).toEqual([
      { scope: "harness", harnessId: "claude", probeTimeoutSeconds: 120 },
    ]);
    expect(pressedLabels()).toEqual(["120 s"]);
    expect(tracked).toHaveBeenCalledTimes(1);
    expect(tracked).toHaveBeenCalledWith(
      "providers",
      "catalogProbeTimeoutSameForAll",
    );
  });

  it("turning the switch on clears this provider's own value and shows the shared one", async () => {
    const harness = renderReady(defaults(60, { claude: 90 }));
    await waitFor(() => {
      expect(pressedLabels()).toEqual(["90 s"]);
    });

    fireEvent.click(sameForAllSwitch());

    await waitFor(() => {
      expect(sameForAllSwitch().getAttribute("aria-checked")).toBe("true");
    });
    expect(harness.sets).toEqual([
      { scope: "harness", harnessId: "claude", probeTimeoutSeconds: null },
    ]);
    expect(pressedLabels()).toEqual(["60 s"]);
    expect(tracked).toHaveBeenCalledTimes(1);
    expect(tracked).toHaveBeenCalledWith(
      "providers",
      "catalogProbeTimeoutSameForAll",
    );
  });

  it("writes nothing when the already-pressed segment is clicked", async () => {
    const harness = renderReady(defaults(90, {}));
    await waitFor(() => {
      expect(pressedLabels()).toEqual(["90 s"]);
    });

    fireEvent.click(segment("90 s"));
    await settled();

    expect(harness.sets).toEqual([]);
    expect(tracked).not.toHaveBeenCalled();
  });

  it("shows a hand-edited shared value of 75 as a pressed 75 s segment", async () => {
    renderReady(defaults(75, {}));
    await waitFor(() => {
      expect(pressedLabels()).toEqual(["75 s"]);
    });
    expect(segmentLabels()).toEqual(["60 s", "75 s", "90 s", "120 s", "180 s"]);
  });

  it("replaces the value with the repair sentence when the read fails, and writes nothing", async () => {
    const { harness, queryClient } = mountHarness({
      ...defaults(60, {}),
      failReads: true,
    });
    renderGroup(queryClient);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't read this host's setting");
    expect(alert.textContent).toContain("~/.traycer/cli/config.json");
    expect(pressedLabels()).toEqual([]);
    expect(sameForAllSwitch().hasAttribute("disabled")).toBe(true);
    expect(segment("120 s").hasAttribute("disabled")).toBe(true);
    expect(harness.sets).toEqual([]);
  });
});

describe("catalogTimeoutOptions", () => {
  const bounds = (minSeconds: number, maxSeconds: number) => ({
    minSeconds,
    maxSeconds,
  });

  it("offers the four presets before the host has answered", () => {
    expect(catalogTimeoutOptions(null, null)).toEqual([
      { seconds: 60, label: "60 s" },
      { seconds: 90, label: "90 s" },
      { seconds: 120, label: "120 s" },
      { seconds: 180, label: "180 s" },
    ]);
  });

  it("returns exactly the presets when the shown value is one of them", () => {
    expect(
      catalogTimeoutOptions(bounds(60, 180), 120).map((o) => o.seconds),
    ).toEqual([60, 90, 120, 180]);
  });

  it("filters the presets to the host's bounds and adds the bounds themselves", () => {
    expect(
      catalogTimeoutOptions(bounds(75, 120), 90).map((o) => o.seconds),
    ).toEqual([75, 90, 120]);
  });

  it("offers both bounds when they sit outside every preset", () => {
    expect(catalogTimeoutOptions(bounds(240, 300), 240)).toEqual([
      { seconds: 240, label: "240 s" },
      { seconds: 300, label: "300 s" },
    ]);
  });

  it("keeps a shown off-preset value as a segment, in order", () => {
    expect(
      catalogTimeoutOptions(bounds(60, 180), 75).map((o) => o.label),
    ).toEqual(["60 s", "75 s", "90 s", "120 s", "180 s"]);
  });

  it("keeps an out-of-bounds shown value visible, and dedupes it against a preset", () => {
    expect(
      catalogTimeoutOptions(bounds(60, 180), 30).map((o) => o.seconds),
    ).toEqual([30, 60, 90, 120, 180]);
    expect(
      catalogTimeoutOptions(bounds(60, 180), 60).map((o) => o.seconds),
    ).toEqual([60, 90, 120, 180]);
  });
});

describe("catalogTimeoutRowsSupported", () => {
  it("is true only when both methods are at 1.1 or later on major 1", () => {
    expect(catalogTimeoutRowsSupported(V11, V11)).toBe(true);
    expect(catalogTimeoutRowsSupported({ major: 1, minor: 2 }, V11)).toBe(true);
  });

  it("is false when either method is at 1.0", () => {
    expect(catalogTimeoutRowsSupported(V10, V11)).toBe(false);
    expect(catalogTimeoutRowsSupported(V11, V10)).toBe(false);
    expect(catalogTimeoutRowsSupported(V10, V10)).toBe(false);
  });

  it("is false when either method is absent, even if the other is unknown", () => {
    expect(catalogTimeoutRowsSupported(false, V11)).toBe(false);
    expect(catalogTimeoutRowsSupported(V11, false)).toBe(false);
    expect(catalogTimeoutRowsSupported(false, null)).toBe(false);
    expect(catalogTimeoutRowsSupported(null, false)).toBe(false);
  });

  it("is null while either method is unknown and neither is absent", () => {
    expect(catalogTimeoutRowsSupported(null, V11)).toBeNull();
    expect(catalogTimeoutRowsSupported(V11, null)).toBeNull();
    expect(catalogTimeoutRowsSupported(null, null)).toBeNull();
  });

  it("is false on another major, which this client has no downgrade path for", () => {
    expect(catalogTimeoutRowsSupported({ major: 2, minor: 0 }, V11)).toBe(
      false,
    );
  });
});
