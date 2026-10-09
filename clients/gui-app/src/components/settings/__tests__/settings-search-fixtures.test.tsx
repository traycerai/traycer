import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SETTINGS_SEARCH_FIXTURES,
  type SettingsSearchFixtureSection,
} from "@/components/settings/__tests__/settings-search-fixture-registry";
import {
  assertSettingsSearchTargets,
  assertSettingsSearchTargetsByNavigation,
} from "@/components/settings/__tests__/settings-search-targets";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { AppDiagnosticsSettingsPanel } from "@/components/settings/panels/app-diagnostics-settings-panel";
import { AppNotificationsSettingsPanel } from "@/components/settings/panels/app-notifications-settings-panel";
import { AppearanceSettingsPanel } from "@/components/settings/panels/appearance-settings-panel";
import { BrowserSettingsPanel } from "@/components/settings/panels/browser-settings-panel";
import { GeneralSettingsPanel } from "@/components/settings/panels/general-settings-panel";
import { GettingStartedSettingsPanel } from "@/components/settings/panels/getting-started-settings-panel";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { LayoutSettingsPanel } from "@/components/settings/panels/layout-settings-panel";
import { OpeningBehaviorPanel } from "@/components/settings/panels/opening-behavior-panel";
import { PermissionsSettingsPanel } from "@/components/settings/panels/permissions-settings-panel";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import { setMobileApp, setPhoneLayoutOnly } from "@/lib/mobile-app";
import type { SettingsAvailabilityContext } from "@/lib/settings/settings-availability";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";

// Layout's provider list is read through the WATCHED host's scope. It carries
// no anchors - the set exists only for providers a host has reported - so the
// contract needs the page mounted, not connected, and resolving a real scope
// would need a whole host runtime for content this test never asserts. Mocked
// at the same boundary the panel's own suite uses.
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => null,
}));

// The host Overview re-provides a scoped STREAM binding for its import and
// migration rows, and the real hook reads the auth service of a host runtime
// this executor does not stand up. Under a connecting scope there is nothing
// to bind anyway - `null` is what the real hook answers there too - and the
// rows that ride the stream are withheld until the host is usable.
vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: () => null,
}));

vi.mock("@/hooks/rate-limits/use-rate-limit-host-scope", () => ({
  useRateLimitResolveHostScope: () => ({
    scope: hostScopeFixture({}),
    hasExplicitPick: false,
  }),
}));

// Permissions and the host Overview are the executor panels that read a host
// scope: Permissions' tab bar and Modes row sit outside `HostScopeGate`, and
// the Overview's header and tab bar render in every host state, so the
// contract mounts both under a `connecting` scope - the state where every
// host-backed body is withheld - and the fixture's `hostScope` says which
// state to serve. The ref is set per test.
const hostScopeState = vi.hoisted((): { current: "connecting" | null } => ({
  current: null,
}));
vi.mock(
  "@/components/settings/host-scope/use-host-scope",
  async (importOriginal) => {
    const { hostScopeFixture: fixture } =
      await import("@/components/settings/host-scope/host-scope-fixture");
    return {
      ...(await importOriginal<
        typeof import("@/components/settings/host-scope/use-host-scope")
      >()),
      useHostScope: () =>
        fixture(
          hostScopeState.current === "connecting"
            ? { status: "connecting" }
            : {},
        ),
    };
  },
);

// The Layout panel wraps itself directly in the shared watched-usage read
// (`LayoutUsageProvider`), which resolves a host scope through a real
// `HostRuntimeProvider` this suite never mounts. A pass-through here, mocked
// at the same boundary `layout-settings-panel.test.tsx` uses, keeps the anchor
// rows drawing for real without standing up that scope.
vi.mock(
  "@/components/layout-editor/inspector/provider-limit-windows",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/layout-editor/inspector/provider-limit-windows")
    >()),
    ProviderLimitWindowsReader: (props: {
      readonly children: (limits: {
        windows: ReadonlyArray<never>;
        drawnKeys: ReadonlyArray<never>;
      }) => ReactNode;
    }) => props.children({ windows: [], drawnKeys: [] }),
    LayoutUsageProvider: (props: { readonly children: ReactNode }) =>
      props.children,
  }),
);

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
  "getting-started": <GettingStartedSettingsPanel />,
  general: <GeneralSettingsPanel />,
  appearance: <AppearanceSettingsPanel />,
  layout: <LayoutSettingsPanel />,
  "opening-behavior": <OpeningBehaviorPanel />,
  permissions: <PermissionsSettingsPanel />,
  browser: <BrowserSettingsPanel />,
  "app-notifications": <AppNotificationsSettingsPanel />,
  "app-diagnostics": <AppDiagnosticsSettingsPanel />,
  host: <HostSettingsPanel />,
};

const executed = new Set<string>();

afterEach(() => {
  cleanup();
  hostScopeState.current = null;
  setMobileApp(false);
  setPhoneLayoutOnly(false);
  setFeatureSettingsBridge(null);
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  useSettingsSearchStore.setState({
    query: "",
    pendingReveal: null,
    handoffPending: false,
  });
});

describe("settings search fixtures", () => {
  for (const fixture of SETTINGS_SEARCH_FIXTURES) {
    for (const shell of fixture.shells) {
      it(`${fixture.section} lands every result with ${shell.name}`, () => {
        hostScopeState.current = fixture.hostScope;
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
        // Layout and Appearance show only one tab's rows at a time, so their
        // anchors cannot all be judged visible from this one static mount -
        // each is checked after navigating to it, the way a real search
        // result would.
        const assert =
          fixture.section === "layout" || fixture.section === "appearance"
            ? assertSettingsSearchTargetsByNavigation
            : assertSettingsSearchTargets;
        assert(fixture.section, shell.context, container);
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
 * none), the window-level feature-settings bridge, the mobile-app flag and
 * whether the phone layout is drawn (the installed app draws it at every width).
 */
function mountInShell(
  context: SettingsAvailabilityContext,
  panel: ReactNode,
  onContext: (context: SettingsAvailabilityContext) => void,
): HTMLElement {
  setMobileApp(context.mobileApp);
  setPhoneLayoutOnly(context.phoneLayout);
  setFeatureSettingsBridge(context.featureSettings);
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
