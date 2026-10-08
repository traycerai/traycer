import { cleanup, render } from "@testing-library/react";
import { createContext } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  StatusBarProviderSegmentModel,
  StatusBarRateLimitWindow,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

/**
 * The passivity contract, pinned where it is actually decided.
 *
 * Every other suite mocks `ProviderLimitWindowsReader` itself - which is
 * right for what those suites are about and leaves the one promise this
 * module makes untested: opening a provider's level (or an editor page) must
 * not be able to start a fetch, warm a cold provider, or report on a reading
 * it caused (L-96). So here the DEPENDENCY (`useStatusBarRateLimitSegments`)
 * is mocked and the module under test - `LayoutUsageProvider` /
 * `ProviderLimitWindowsReader` - is real, and what is asserted is the
 * argument it subscribes with.
 */

/** The half of the hook's argument this suite is about - see the loop below. */
interface SegmentsCall {
  readonly mode: string;
  readonly editing: boolean;
}

// The parameter is DECLARED so `segments.mock.calls` is a tuple with an
// element at 0; a `vi.fn(() => ...)` types its calls as `[]` and reading the
// argument is a compile error.
const segments = vi.hoisted(() =>
  vi.fn((_input: SegmentsCall) => ({
    cluster: { kind: "segments" as const, segments: CLUSTER_SEGMENTS },
    mountTargets: [],
    refresh: null,
  })),
);

vi.mock("@/hooks/rate-limits/use-status-bar-rate-limit-segments", () => ({
  useStatusBarRateLimitSegments: segments,
  useStatusBarWindowedProviders: () => [],
}));

/**
 * The reader boundary's own scope input, mutable per test so the gate tests
 * below can drive every branch `WatchedProviderLimitWindows` takes without a
 * real `useHostScope` stack. Wrapped in a `vi.fn` so a credit-only provider's
 * "never resolves a scope at all" claim (isWindowedRateLimitProvider gates
 * BEFORE this hook mounts) has a call count to assert against, not just an
 * absent render effect.
 */
const watchScope = vi.hoisted(() => ({
  current: {
    scope: { hostId: "host-1", status: "ready" },
    hasExplicitPick: false,
  },
}));
const useWatchHostScopeSpy = vi.hoisted(() => vi.fn(() => watchScope.current));
vi.mock("@/hooks/host-scope/use-watch-host-scope", () => ({
  useWatchHostScope: useWatchHostScopeSpy,
}));

vi.mock("@/hooks/rate-limits/use-rate-limit-profile-selection", () => ({
  useRateLimitProfileSelection: () => ({ kind: "all" }),
}));

/**
 * `useScopedHostBinding` and the ambient `useHostBinding()` it falls back to
 * are stubbed here to a fixed, always-non-null shape: this file is about
 * WHICH BRANCH the reader takes (credit-only bypass, an unusable explicit
 * pick, `following`), never about host resolution itself - that is
 * `provider-limit-windows-scoped-cache.test.tsx`'s real-cache proof. Nothing
 * downstream in this suite reads `HostRuntimeContext`'s value (every
 * dependency below `ReadProviderLimitWindows` is mocked above), so the exact
 * binding is inert scaffolding the reader's `<HostRuntimeContext.Provider>`
 * needs to render without throwing.
 */
vi.mock("@/components/settings/host-scope/use-scoped-host-binding", () => ({
  useScopedHostBinding: () => ({ hostId: "scoped-host" }),
}));
// `createContext` is called INSIDE the factory, not hoisted out to a shared
// const: `vi.mock` factories run lazily (on first import of the mocked
// path), but `vi.hoisted` callbacks run eagerly, before this file's own
// `import { createContext } from "react"` has been evaluated - a shared
// hoisted const here hits `createContext` before it exists.
vi.mock("@/lib/host", () => ({
  HostRuntimeContext: createContext<{ readonly hostId: string | null } | null>(
    null,
  ),
  useHostBinding: () => ({ hostId: "ambient-host" }),
}));

import {
  LayoutUsageProvider,
  ProviderLimitWindowsReader,
} from "@/components/layout-editor/inspector/provider-limit-windows";
import { useLayoutUsage } from "@/components/layout-editor/inspector/use-layout-usage";
import { isWindowedRateLimitProvider } from "@/lib/rate-limits/rate-limit-window-catalog";

const PROVIDER: RateLimitProviderId = "claude-code";
const CREDIT_PROVIDER: RateLimitProviderId = "kilocode";

function limitWindow(windowKey: string): StatusBarRateLimitWindow {
  return {
    windowKey,
    label: windowKey,
    labelIsDuration: true,
    kind: "session",
    usedPercent: 40,
    resetsAt: null,
    severity: "healthy",
  };
}

function segment(
  providerId: RateLimitProviderId,
  profileId: string | null,
  windowKeys: ReadonlyArray<string>,
  shownKeys: ReadonlyArray<string>,
): StatusBarProviderSegmentModel {
  const windows = windowKeys.map(limitWindow);
  const shown = shownKeys.map(limitWindow);
  return {
    providerId,
    profileId,
    account: null,
    hidden: false,
    state: "live",
    reason: null,
    readAt: null,
    windows,
    shown,
    tightest: shown.at(0) ?? null,
  };
}

/**
 * Two accounts of the same provider plus a second provider: both segments of
 * the first describe the same windows, and one of them is what the strip is
 * drawing right now.
 */
const CLUSTER_SEGMENTS: ReadonlyArray<StatusBarProviderSegmentModel> = [
  segment(PROVIDER, null, ["5h", "week"], ["5h"]),
  segment(PROVIDER, "profile-2", ["5h", "week"], ["5h"]),
  segment("codex", null, ["month"], ["month"]),
];

afterEach(() => {
  segments.mockClear();
  useWatchHostScopeSpy.mockClear();
  watchScope.current = {
    scope: { hostId: "host-1", status: "ready" },
    hasExplicitPick: false,
  };
  cleanup();
});

/**
 * `useProviderLimitWindows` is gone - the passive read now lives inside
 * `LayoutUsageProvider`/`ReadLayoutUsage`, and the window filter is inline in
 * `ProviderLimitWindowsReader`. There is no hook left to call directly, so
 * these two assertions migrate to the reader itself - the real owning
 * boundary a consumer (`ProviderLevel`, `ProviderLimitsControl`, any future
 * one) actually renders.
 */
describe("the provider level's window read (L-96)", () => {
  function renderReaderWindows(): ReadonlyArray<{
    readonly windows: ReadonlyArray<StatusBarRateLimitWindow>;
    readonly drawnKeys: ReadonlyArray<string>;
  }> {
    const seen: Array<{
      readonly windows: ReadonlyArray<StatusBarRateLimitWindow>;
      readonly drawnKeys: ReadonlyArray<string>;
    }> = [];
    render(
      <ProviderLimitWindowsReader providerId={PROVIDER}>
        {(limits) => {
          seen.push(limits);
          return null;
        }}
      </ProviderLimitWindowsReader>,
    );
    return seen;
  }

  it("observes the strip's own segments passively, never a read of its own", () => {
    renderReaderWindows();

    expect(segments).toHaveBeenCalled();
    for (const [input] of segments.mock.calls) {
      expect(input).toMatchObject({ mode: "passive", editing: true });
    }
  });

  it("offers each window once, and says which of them is drawn", () => {
    const seen = renderReaderWindows();

    // One entry per window however many accounts report it, and only this
    // provider's - the checklist is one provider's own limits.
    expect(seen.at(-1)?.windows.map((window) => window.windowKey)).toEqual([
      "5h",
      "week",
    ]);
    expect(seen.at(-1)?.drawnKeys).toEqual(["5h"]);
  });
});

/**
 * `ProviderLimitWindowsReader`'s own routing, one watched-host binding shared
 * by every consumer (`ProviderLevel`, `ProviderLimitsControl`) - see that
 * module's doc comment. Asserted here at the boundary that actually decides
 * it, with `segments` (the passive read's own dependency) as the observable
 * proof of "did a read happen at all": a bypass that merely rendered nothing
 * would still be provable wrong by a later change that let the read through
 * anyway, which is exactly what these assert against.
 */
describe("ProviderLimitWindowsReader's routing (credit-only bypass, unusable explicit pick)", () => {
  function renderReader(providerId: RateLimitProviderId) {
    const seen: Array<{
      readonly windows: ReadonlyArray<StatusBarRateLimitWindow>;
      readonly drawnKeys: ReadonlyArray<string>;
    }> = [];
    render(
      <ProviderLimitWindowsReader providerId={providerId}>
        {(limits) => {
          seen.push(limits);
          return null;
        }}
      </ProviderLimitWindowsReader>,
    );
    return seen;
  }

  it("bypasses the reader entirely for a credit-only provider - no scope resolved, no passive read", () => {
    expect(isWindowedRateLimitProvider(CREDIT_PROVIDER)).toBe(false);

    const seen = renderReader(CREDIT_PROVIDER);

    expect(seen).toEqual([{ windows: [], drawnKeys: [] }]);
    // Not just "the checklist is empty" - the scope and the passive read were
    // never reached at all, which is the actual guard the fix adds.
    expect(useWatchHostScopeSpy).not.toHaveBeenCalled();
    expect(segments).not.toHaveBeenCalled();
  });

  it("gates an unusable EXPLICIT pick to NO_WINDOWS without mounting the passive read", () => {
    watchScope.current = {
      scope: { hostId: "picked-host", status: "unreachable" },
      hasExplicitPick: true,
    };

    const seen = renderReader(PROVIDER);

    expect(seen).toEqual([{ windows: [], drawnKeys: [] }]);
    expect(segments).not.toHaveBeenCalled();
  });

  // An unreachable host with no explicit pick is the FOLLOWED active one:
  // `hasExplicitPick && !isHostScopeUsable(status)` is false, so the reader
  // does not gate - a merely-offline active host is routine
  // (`WatchHostScope.hasExplicitPick`'s own doc), and the passive read's own
  // `cluster.kind !== "segments"` handling is what answers for it instead.
  it.each([
    { hostId: "host-1", status: "unreachable", hasExplicitPick: false },
    { hostId: "host-1", status: "following", hasExplicitPick: false },
    { hostId: "picked-host", status: "ready", hasExplicitPick: true },
  ])(
    "mounts the read for a $status host (explicit pick: $hasExplicitPick)",
    ({ hostId, status, hasExplicitPick }) => {
      watchScope.current = { scope: { hostId, status }, hasExplicitPick };

      renderReader(PROVIDER);

      expect(segments).toHaveBeenCalled();
    },
  );
});

/**
 * The whole point of hoisting the read out of the reader and into
 * `LayoutUsageProvider` (phase 2): an editor with a Providers list, several
 * open provider rows and a Style example all under ONE provider must share
 * ONE passive subscription, not one per sibling. `ProviderLevel`/
 * `ProviderLimitsControl`'s own "one reading, shared" contract
 * (`provider-limits-choose.test.tsx`) only proves it for TWO consumers of the
 * SAME provider row; this proves it holds for an arbitrary mix of siblings -
 * `useLayoutUsage()` call sites and `ProviderLimitWindowsReader` instances for
 * DIFFERENT providers - under one explicit provider, which is the shape a
 * real editor page actually renders.
 */
describe("one shared read across sibling consumers under an explicit LayoutUsageProvider", () => {
  function Consumer(props: { readonly providerId: RateLimitProviderId }) {
    return (
      <ProviderLimitWindowsReader providerId={props.providerId}>
        {(limits) => (
          <span data-testid={`limits-${props.providerId}`}>
            {limits.windows.map((window) => window.windowKey).join(",")}
          </span>
        )}
      </ProviderLimitWindowsReader>
    );
  }

  /** Records the exact `cluster` object each sibling's `useLayoutUsage()`
   * call received, so the test can assert REFERENTIAL identity across
   * siblings - the precise claim "one shared read", where a same-shaped-but-
   * separately-computed cluster from two independent reads would still pass
   * a text-content comparison. */
  function UsageConsumer(props: {
    readonly onRead: (cluster: unknown) => void;
  }) {
    const usage = useLayoutUsage();
    props.onRead(usage.cluster);
    return null;
  }

  it("reads the segments hook exactly once for four sibling consumers of two different providers", () => {
    const seenClusters: unknown[] = [];
    const { getByTestId } = render(
      <LayoutUsageProvider>
        <UsageConsumer onRead={(cluster) => seenClusters.push(cluster)} />
        <Consumer providerId={PROVIDER} />
        <Consumer providerId="codex" />
        <UsageConsumer onRead={(cluster) => seenClusters.push(cluster)} />
      </LayoutUsageProvider>,
    );

    expect(segments).toHaveBeenCalledTimes(1);
    // Every sibling reads the SAME cluster instance - one `ReadLayoutUsage`
    // mount, not one independent computation per consumer.
    expect(seenClusters).toHaveLength(2);
    expect(seenClusters[0]).toBe(seenClusters[1]);
    // And each reader's own filtered view over that one shared cluster is
    // still correct - not just "mounted without crashing".
    expect(getByTestId("limits-claude-code").textContent).toBe("5h,week");
    expect(getByTestId("limits-codex").textContent).toBe("month");
  });
});
