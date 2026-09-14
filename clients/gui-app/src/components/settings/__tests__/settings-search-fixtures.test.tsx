import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SETTINGS_SEARCH_FIXTURES,
  type SettingsSearchFixtureSection,
} from "@/components/settings/__tests__/settings-search-fixture-registry";
import { assertSettingsSearchTargets } from "@/components/settings/__tests__/settings-search-targets";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { AppDiagnosticsSettingsPanel } from "@/components/settings/panels/app-diagnostics-settings-panel";
import { AppNotificationsSettingsPanel } from "@/components/settings/panels/app-notifications-settings-panel";
import { AppearanceSettingsPanel } from "@/components/settings/panels/appearance-settings-panel";
import { GeneralSettingsPanel } from "@/components/settings/panels/general-settings-panel";
import { LayoutSettingsPanel } from "@/components/settings/panels/layout-settings-panel";
import { OpeningBehaviorPanel } from "@/components/settings/panels/opening-behavior-panel";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import { setMobileApp } from "@/lib/mobile-app";
import type { SettingsAvailabilityContext } from "@/lib/settings/settings-availability";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";

// Layout's provider list is read through the WATCHED host's scope. It carries
// no anchors - the set exists only for providers a host has reported - so the
// contract needs the page mounted, not connected, and resolving a real scope
// would need a whole host runtime for content this test never asserts. Mocked
// at the same boundary the panel's own suite uses.
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => null,
}));

vi.mock("@/hooks/rate-limits/use-rate-limit-host-scope", () => ({
  useRateLimitResolveHostScope: () => ({
    scope: hostScopeFixture({}),
    hasExplicitPick: false,
  }),
}));

// General's replay button and Sounds' host link navigate; nothing here clicks
// them, but both hooks need a router to be CALLED.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));

/**
 * The always-included DOM executor for settings search.
 *
 * It walks the registry — every anchored section, every shell listed for it —
 * mounts that section's panel in that shell, and runs the DOM contract:
 * each anchored entry lands on exactly one unconcealed element where its gate
 * is on and on none where it is off, and every anchor the panel renders is one
 * of that section's indexed anchors. A section's shells live in the registry,
 * not in the panel's own suite, so the index test can check that none is
 * missing (see `settings-search-fixture-registry.ts`).
 */
const MOUNTS: {
  readonly [Section in SettingsSearchFixtureSection]: ReactNode;
} = {
  general: <GeneralSettingsPanel />,
  appearance: <AppearanceSettingsPanel />,
  layout: <LayoutSettingsPanel />,
  "opening-behavior": <OpeningBehaviorPanel />,
  "app-notifications": <AppNotificationsSettingsPanel />,
  "app-diagnostics": <AppDiagnosticsSettingsPanel />,
};

const executed = new Set<string>();

afterEach(() => {
  cleanup();
  setMobileApp(false);
  setFeatureSettingsBridge(null);
  setMobileFooter(DEFAULT_STATUS_BAR_LAYOUT.mobileFooter);
});

describe("settings search fixtures", () => {
  for (const fixture of SETTINGS_SEARCH_FIXTURES) {
    for (const shell of fixture.shells) {
      it(`${fixture.section} lands every result with ${shell.name}`, () => {
        let mounted: SettingsAvailabilityContext | null = null;
        const container = mountInShell(
          shell.context,
          MOUNTS[fixture.section],
          (context) => {
            mounted = context;
          },
        );

        // The context the contract is judged by must be the shell the panel
        // actually resolved, or the zero-target half proves nothing.
        expect(mounted).toEqual(shell.context);
        assertSettingsSearchTargets(fixture.section, shell.context, container);
        executed.add(`${fixture.section} / ${shell.name}`);
      });
    }
  }

  // Runs last: a loop that skipped a registered shell would otherwise pass by
  // asserting nothing about it.
  it("mounted every registered shell", () => {
    const registered = SETTINGS_SEARCH_FIXTURES.flatMap((fixture) =>
      fixture.shells.map((shell) => `${fixture.section} / ${shell.name}`),
    );
    expect([...executed].sort()).toEqual([...registered].sort());
  });
});

/**
 * Mounts `panel` in exactly the shell `context` describes: its runner host (or
 * none), the window-level feature-settings bridge, and the mobile-app flag.
 */
function mountInShell(
  context: SettingsAvailabilityContext,
  panel: ReactNode,
  onContext: (context: SettingsAvailabilityContext) => void,
): HTMLElement {
  setMobileApp(context.mobileApp);
  setFeatureSettingsBridge(context.featureSettings);
  setMobileFooter(context.mobileFooter);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const tree = (
    <>
      <ShellProbe onContext={onContext} />
      {panel}
    </>
  );
  return render(
    <QueryClientProvider client={queryClient}>
      {context.runnerHost === null ? (
        tree
      ) : (
        <RunnerHostProvider runnerHost={context.runnerHost}>
          {tree}
        </RunnerHostProvider>
      )}
    </QueryClientProvider>,
  ).container;
}

function ShellProbe(props: {
  readonly onContext: (context: SettingsAvailabilityContext) => void;
}): ReactNode {
  props.onContext(useSettingsAvailabilityContext());
  return null;
}

function setFeatureSettingsBridge(
  featureSettings: SettingsAvailabilityContext["featureSettings"],
): void {
  (globalThis as { runnerHost?: unknown }).runnerHost =
    featureSettings === null ? undefined : { platform: { featureSettings } };
}

/**
 * The one shell fact that lives in a store rather than on the window or the
 * runner host. Written straight into `layout-store` so the panel and the
 * probe below resolve the same value the registry names - the mobile footer
 * decides whether that build has a strip at all, and the whole group's gate
 * reads it.
 */
function setMobileFooter(mobileFooter: boolean): void {
  useLayoutStore.setState((state) => ({
    statusBar: { ...state.statusBar, mobileFooter },
  }));
}
