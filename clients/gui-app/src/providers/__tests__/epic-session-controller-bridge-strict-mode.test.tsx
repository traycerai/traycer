import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpicSessionControllerEnvironment } from "@/lib/registries/epic-session-controller";

// Mirrors the sibling suites' `@/lib/host` mock (`epic-session-provider.test.tsx`,
// `epic-session-transport-ownership.test.tsx`): the bridge only reads these two
// hooks off the module, never a provider, so replacing the module is cheaper
// than mounting `HostRuntimeProvider`.
const hostBindingRef = vi.hoisted(
  (): { value: { readonly hostClient: unknown } | null } => ({
    value: null,
  }),
);
const authServiceStub = vi.hoisted(() => ({
  revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
}));
vi.mock("@/lib/host", () => ({
  useHostBinding: () => hostBindingRef.value,
  useAuthService: () => authServiceStub,
}));

// A stable function reference, like the real hook's contract: the bridge's own
// `useMemo` depends on it, and a fresh function every render would recompute
// `environment` on every commit and mask the identity this test is about.
const openTransportStub = vi.hoisted(() => vi.fn());
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => openTransportStub,
}));

/**
 * Spies standing in for the two controller entry points the bridge calls.
 * `importOriginal` keeps every other export (`getEpicSessionController`, the
 * singleton itself) real: `epic-parking-open-tabs.ts` calls
 * `getEpicSessionController()` at MODULE IMPORT time (it subscribes to the
 * canvas store as a side effect), so a full replacement of this module would
 * throw before the bridge ever rendered.
 */
const controllerSpies = vi.hoisted(() => ({
  install: vi.fn<(environment: unknown) => void>(),
  uninstall: vi.fn<(environment: unknown) => void>(),
}));
vi.mock("@/lib/registries/epic-session-controller", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/registries/epic-session-controller")
    >();
  return {
    ...actual,
    installEpicSessionControllerEnvironment: (
      environment: EpicSessionControllerEnvironment | null,
    ): void => {
      controllerSpies.install(environment);
    },
    uninstallEpicSessionControllerEnvironment: (
      environment: EpicSessionControllerEnvironment,
    ): void => {
      controllerSpies.uninstall(environment);
    },
  };
});

import { EpicSessionControllerBridge } from "@/providers/epic-session-controller-bridge";

function renderBridgeInStrictMode(): RenderResult {
  const queryClient = new QueryClient();
  return render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <EpicSessionControllerBridge />
      </QueryClientProvider>
    </StrictMode>,
  );
}

describe("<EpicSessionControllerBridge /> under React StrictMode", () => {
  beforeEach(() => {
    hostBindingRef.value = null;
    controllerSpies.install.mockClear();
    controllerSpies.uninstall.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the environment installed across StrictMode's mount-cleanup-remount instead of uninstalling what the remount just installed", async () => {
    renderBridgeInStrictMode();

    // The bug's deferred cleanup runs on a queued microtask, not synchronously
    // with the render commit - flush the microtask queue before asserting.
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // StrictMode's mount -> cleanup -> remount runs the effect twice; both
    // installs necessarily carry the SAME environment object, since nothing
    // between them changes the `useMemo` deps.
    expect(controllerSpies.install.mock.calls.length).toBe(2);
    const [firstInstalled] = controllerSpies.install.mock.calls[0] ?? [];
    const [secondInstalled] = controllerSpies.install.mock.calls[1] ?? [];
    expect(firstInstalled).toBe(secondInstalled);

    // THE REGRESSION: unguarded, the first mount's deferred cleanup fires
    // after the second mount's install and uninstalls the environment the
    // component is still using - no epic session can ever start in a dev
    // build. Still mounted, so this must be zero.
    expect(controllerSpies.uninstall).not.toHaveBeenCalled();
  });

  it("uninstalls the environment exactly once, with the same object it installed, on a real unmount", async () => {
    const view = renderBridgeInStrictMode();
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const lastInstalled = controllerSpies.install.mock.calls.at(-1)?.[0];
    expect(lastInstalled).toBeDefined();
    expect(controllerSpies.uninstall).not.toHaveBeenCalled();

    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The fix must not break the ordinary teardown: exactly one uninstall,
    // matching the environment that was actually live.
    expect(controllerSpies.uninstall).toHaveBeenCalledTimes(1);
    expect(controllerSpies.uninstall).toHaveBeenCalledWith(lastInstalled);
  });
});
