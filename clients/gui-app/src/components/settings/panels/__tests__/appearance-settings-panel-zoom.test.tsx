import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";
import { assertSettingsSearchTargets } from "@/components/settings/__tests__/settings-search-targets";
import { AppearanceSettingsPanel } from "@/components/settings/panels/appearance-settings-panel";
import {
  isZoomRowAvailable,
  type SettingsAvailabilityContext,
} from "@/lib/settings/settings-availability";
import type { DesktopZoomBridge } from "@/lib/windows/types";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

const zoomState: {
  bridge: FakeZoomBridge | null;
} = {
  bridge: null,
};
let queryClient: QueryClient;

class FakeZoomBridge implements DesktopZoomBridge {
  readonly ladder = [67, 75, 80, 90, 100, 110, 125, 150];
  readonly stepIn = vi.fn(() => Promise.resolve(110));
  readonly stepOut = vi.fn(() => Promise.resolve(90));
  readonly reset = vi.fn(() => Promise.resolve(100));
  readonly set = vi.fn((percent: number) => Promise.resolve(percent));
  private percent = 100;
  private readonly handlers = new Set<(percent: number) => void>();

  get(): Promise<number> {
    return Promise.resolve(this.percent);
  }

  onChange(handler: (percent: number) => void): { dispose: () => void } {
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  emit(percent: number): void {
    this.percent = percent;
    for (const handler of this.handlers) {
      handler(percent);
    }
  }

  listenerCount(): number {
    return this.handlers.size;
  }
}

describe("<AppearanceSettingsPanel /> zoom control", () => {
  beforeEach(() => {
    zoomState.bridge = new FakeZoomBridge();
    queryClient = createQueryClient();
  });

  afterEach(() => {
    queryClient.clear();
    cleanup();
    zoomState.bridge = null;
  });

  it("renders the desktop Display zoom row and reflects live changes", async () => {
    const bridge = zoomState.bridge;
    renderWithQueryClient(<AppearanceSettingsPanel />);

    const zoomSelect = await screen.findByRole("combobox", {
      name: "Display zoom",
    });
    await waitFor(() => {
      expect(zoomSelect.textContent).toContain("100%");
    });
    await waitFor(() => {
      expect(bridge?.listenerCount()).toBe(1);
    });

    act(() => {
      bridge?.emit(125);
    });

    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Display zoom" }).textContent,
      ).toContain("125%");
    });
  });

  it("hides the Display zoom row without the desktop bridge", () => {
    zoomState.bridge = null;
    renderWithQueryClient(<AppearanceSettingsPanel />);

    expect(screen.queryByLabelText("Display zoom")).toBeNull();
  });

  // The search index offers Zoom exactly where this row renders. Both halves:
  // an entry left always-available fails the bridge-absent case.
  it("matches the search index with the zoom bridge present", () => {
    const container = renderWithQueryClient(<AppearanceSettingsPanel />);

    const context = currentAvailabilityContext();
    expect(isZoomRowAvailable(context)).toBe(true);
    assertSettingsSearchTargets("appearance", context, container);
  });

  it("matches the search index with the zoom bridge absent", () => {
    zoomState.bridge = null;
    const container = renderWithQueryClient(<AppearanceSettingsPanel />);

    const context = currentAvailabilityContext();
    expect(isZoomRowAvailable(context)).toBe(false);
    assertSettingsSearchTargets("appearance", context, container);
  });

  // A host-less shell has no runner host at all, and every hook the Zoom row
  // needs reaches for one — so the gate has to return before any of them run.
  it("omits the Zoom row, and does not throw, with no runner host above it", () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <AppearanceSettingsPanel />
      </QueryClientProvider>,
    );

    expect(screen.queryByText("Zoom")).toBeNull();
    expect(
      container.querySelector('[data-settings-anchor="appearance-zoom"]'),
    ).toBeNull();
  });
});

let mountedRunnerHost: IRunnerHost | null = null;

function currentAvailabilityContext(): SettingsAvailabilityContext {
  return {
    runnerHost: mountedRunnerHost,
    featureSettings: null,
    mobileApp: false,
  };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

/**
 * Mounts under a runner host whose `zoom` is the case's bridge, so the row's
 * gate resolves the bridge exactly as the desktop shell does.
 */
function renderWithQueryClient(children: ReactNode): HTMLElement {
  mountedRunnerHost = createFakeRunnerHost({ zoom: zoomState.bridge });
  return render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={mountedRunnerHost}>
        {children}
      </RunnerHostProvider>
    </QueryClientProvider>,
  ).container;
}
