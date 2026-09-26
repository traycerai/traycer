vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: vi.fn(),
}));

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  HostLifecycleSetResult,
  HostLifecycleView,
  IHostLifecycleHost,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import { GENERAL } from "@/components/settings/panels/general-settings.definitions";
import { HostLifecycleModeLine } from "@/components/settings/host-scope/host-lifecycle-mode-line";
import { hostLifecycleModePromise } from "@/lib/host/host-lifecycle-copy";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";

function view(overrides: Partial<HostLifecycleView>): HostLifecycleView {
  return {
    desired: { mode: "background", rev: 1, updatedBy: null, updatedAt: null },
    applied: { localHostCapability: "managed", supervisor: "enforcing" },
    pending: "none",
    ...overrides,
  };
}

function buildLifecycleHost(initial: HostLifecycleView): IHostLifecycleHost {
  return {
    get: () => Promise.resolve(initial),
    set: () =>
      Promise.resolve({
        kind: "applied",
        view: initial,
      } satisfies HostLifecycleSetResult),
    onChange: () => ({ dispose: () => undefined }),
    quit: null,
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderLine(runnerHost: IRunnerHost | null): void {
  const tree: ReactNode =
    runnerHost === null ? (
      <HostLifecycleModeLine />
    ) : (
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostLifecycleModeLine />
      </RunnerHostProvider>
    );
  render(
    <QueryClientProvider client={makeQueryClient()}>
      {tree}
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  useSettingsSearchStore.setState({
    pendingReveal: null,
    handoffPending: false,
  });
  vi.mocked(navigateToSettingsSection).mockClear();
});

describe("<HostLifecycleModeLine />", () => {
  it("renders the mode's promise text for a given mode", async () => {
    const host = buildLifecycleHost(
      view({
        desired: { mode: "linked", rev: 1, updatedBy: null, updatedAt: null },
      }),
    );
    renderLine(createFakeRunnerHost({ hostLifecycle: host }));

    const button = await screen.findByTestId("host-overview-lifecycle-line");
    expect(button.textContent).toBe(hostLifecycleModePromise("linked"));
  });

  it("clicking it requests a reveal on general/general-host-lifecycle and navigates to general", async () => {
    const host = buildLifecycleHost(
      view({
        desired: { mode: "ask", rev: 1, updatedBy: null, updatedAt: null },
      }),
    );
    renderLine(createFakeRunnerHost({ hostLifecycle: host }));

    const button = await screen.findByTestId("host-overview-lifecycle-line");
    expect(useSettingsSearchStore.getState().pendingReveal).toBeNull();
    expect(navigateToSettingsSection).not.toHaveBeenCalled();

    fireEvent.click(button);

    const pendingReveal = useSettingsSearchStore.getState().pendingReveal;
    expect(pendingReveal).not.toBeNull();
    expect(pendingReveal?.section).toBe("general");
    expect(pendingReveal?.anchor).toBe(
      GENERAL.definitions.hostLifecycle.anchor,
    );
    expect(navigateToSettingsSection).toHaveBeenCalledWith("general");
    // The reveal is armed before navigating, per the source's own comment -
    // both calls landed by the time the click handler returned, so the
    // pending reveal must already be set at the moment navigation fires.
    expect(useSettingsSearchStore.getState().pendingReveal).not.toBeNull();
  });

  it("renders nothing when the desired mode is 'none'", async () => {
    const changeHandlers: Array<(next: HostLifecycleView) => void> = [];
    const host: IHostLifecycleHost = {
      get: () =>
        Promise.resolve(
          view({
            desired: {
              mode: "linked",
              rev: 1,
              updatedBy: null,
              updatedAt: null,
            },
          }),
        ),
      set: () =>
        Promise.resolve({
          kind: "applied",
          view: view({}),
        } satisfies HostLifecycleSetResult),
      onChange: (handler) => {
        changeHandlers.push(handler);
        return { dispose: () => undefined };
      },
      quit: null,
    };
    renderLine(createFakeRunnerHost({ hostLifecycle: host }));

    await screen.findByTestId("host-overview-lifecycle-line");

    act(() => {
      for (const handler of changeHandlers) {
        handler(
          view({
            desired: { mode: "none", rev: 2, updatedBy: null, updatedAt: null },
          }),
        );
      }
    });

    await waitFor(() => {
      expect(screen.queryByTestId("host-overview-lifecycle-line")).toBeNull();
    });
  });

  it("renders nothing when there is no lifecycle bridge", () => {
    renderLine(createFakeRunnerHost({ hostLifecycle: null }));
    expect(screen.queryByTestId("host-overview-lifecycle-line")).toBeNull();
  });

  it("renders nothing while the view has not loaded yet (no data)", () => {
    const host: IHostLifecycleHost = {
      // Never resolves within this test - the query stays in its initial,
      // dataless state.
      get: () => new Promise(() => undefined),
      set: () =>
        Promise.resolve({
          kind: "applied",
          view: view({}),
        } satisfies HostLifecycleSetResult),
      onChange: () => ({ dispose: () => undefined }),
      quit: null,
    };
    renderLine(createFakeRunnerHost({ hostLifecycle: host }));
    expect(screen.queryByTestId("host-overview-lifecycle-line")).toBeNull();
  });

  it("renders nothing with no runner host at all", () => {
    renderLine(null);
    expect(screen.queryByTestId("host-overview-lifecycle-line")).toBeNull();
  });
});
