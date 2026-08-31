import { createElement, useContext, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Context } from "react";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import type { EpicSessionPresentation } from "@/lib/registries/epic-session-registry";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";

/**
 * Mirrors `src/providers/__tests__/host-runtime-provider-context.test.ts`:
 * the pattern for proving a `globalThis`-pinned context survives Fast
 * Refresh module re-imports. `epic-session-registry.ts` pins THREE contexts
 * (`EpicSessionContext`, `EpicSessionPresentationContext`,
 * `EpicSessionHostClientContext`) via one `createStableDevContext` helper, so
 * each global is exercised the same way.
 */
interface EpicSessionDevGlobals {
  __TRAYCER_EPIC_SESSION_CONTEXT__:
    | Context<OpenEpicStoreHandle | null>
    | undefined;
  __TRAYCER_EPIC_SESSION_PRESENTATION_CONTEXT__:
    | Context<EpicSessionPresentation | null>
    | undefined;
  __TRAYCER_EPIC_SESSION_HOST_CLIENT_CONTEXT__:
    | Context<HostClient<HostRpcRegistry> | null>
    | undefined;
}

const HANDLE_KEY = "__TRAYCER_EPIC_SESSION_CONTEXT__";
const PRESENTATION_KEY = "__TRAYCER_EPIC_SESSION_PRESENTATION_CONTEXT__";
const HOST_CLIENT_KEY = "__TRAYCER_EPIC_SESSION_HOST_CLIENT_CONTEXT__";

// Typed as the dev-globals record alone (not the `typeof globalThis`
// intersection) so the keyed write in `restoreGlobal` type-checks against the
// one property it is generic over - the same shape the source module uses.
const devGlobals: EpicSessionDevGlobals = globalThis as typeof globalThis &
  EpicSessionDevGlobals;

const initialHandleContext = devGlobals[HANDLE_KEY];
const initialPresentationContext = devGlobals[PRESENTATION_KEY];
const initialHostClientContext = devGlobals[HOST_CLIENT_KEY];

function restoreGlobal<K extends keyof EpicSessionDevGlobals>(
  key: K,
  value: EpicSessionDevGlobals[K],
): void {
  if (value === undefined) {
    Reflect.deleteProperty(devGlobals, key);
    return;
  }
  devGlobals[key] = value;
}

function deleteAllPinnedGlobals(): void {
  Reflect.deleteProperty(devGlobals, HANDLE_KEY);
  Reflect.deleteProperty(devGlobals, PRESENTATION_KEY);
  Reflect.deleteProperty(devGlobals, HOST_CLIENT_KEY);
}

afterEach(() => {
  cleanup();
  vi.resetModules();
  restoreGlobal(HANDLE_KEY, initialHandleContext);
  restoreGlobal(PRESENTATION_KEY, initialPresentationContext);
  restoreGlobal(HOST_CLIENT_KEY, initialHostClientContext);
});

describe("epic-session-registry HMR-stable contexts", () => {
  it("retains all three epic-session contexts across Fast Refresh module generations", async () => {
    vi.resetModules();
    deleteAllPinnedGlobals();

    const gen1 = await import("@/lib/registries/epic-session-registry");

    // The globals must now be populated - proof the module actually pinned
    // them, not merely that two generations happen to agree.
    expect(devGlobals[HANDLE_KEY]).toBeDefined();
    expect(devGlobals[PRESENTATION_KEY]).toBeDefined();
    expect(devGlobals[HOST_CLIENT_KEY]).toBeDefined();

    vi.resetModules();
    const gen2 = await import("@/lib/registries/epic-session-registry");

    expect(gen2.EpicSessionContext).toBe(gen1.EpicSessionContext);
    expect(gen2.EpicSessionPresentationContext).toBe(
      gen1.EpicSessionPresentationContext,
    );
    expect(gen2.EpicSessionHostClientContext).toBe(
      gen1.EpicSessionHostClientContext,
    );
  });

  it("negative control: without the pinned globals surviving between imports, two generations get DIFFERENT context objects", async () => {
    // Proves the `toBe` assertions above are discriminating, not vacuous
    // (e.g. because module caching alone would make this pass regardless of
    // whether pinning works): deleting the global right before each import
    // forces a fresh `createContext()` call every time.
    vi.resetModules();
    deleteAllPinnedGlobals();
    const gen1 = await import("@/lib/registries/epic-session-registry");

    vi.resetModules();
    deleteAllPinnedGlobals();
    const gen2 = await import("@/lib/registries/epic-session-registry");

    expect(gen2.EpicSessionContext).not.toBe(gen1.EpicSessionContext);
    expect(gen2.EpicSessionPresentationContext).not.toBe(
      gen1.EpicSessionPresentationContext,
    );
    expect(gen2.EpicSessionHostClientContext).not.toBe(
      gen1.EpicSessionHostClientContext,
    );
  });

  it("a provider mounted from generation 1 is readable by a consumer resolved from generation 2", async () => {
    vi.resetModules();
    deleteAllPinnedGlobals();
    const gen1 = await import("@/lib/registries/epic-session-registry");

    vi.resetModules();
    const gen2 = await import("@/lib/registries/epic-session-registry");

    // Object identity only matters for the `use()`/`useContext()` lookup;
    // any object shaped like the handle works here (mirrors the exemplar's
    // `Object.create(null) as HostRuntimeBinding<...>` binding fake).
    const fakeHandle = Object.create(null) as OpenEpicStoreHandle;

    function Consumer(): ReactNode {
      const value = useContext(gen2.EpicSessionContext);
      return createElement(
        "div",
        { "data-testid": "consumer-value" },
        value === fakeHandle ? "match" : "no-match",
      );
    }

    render(
      createElement(
        gen1.EpicSessionContext.Provider,
        { value: fakeHandle },
        createElement(Consumer),
      ),
    );

    expect(screen.getByTestId("consumer-value").textContent).toBe("match");
  });
});
