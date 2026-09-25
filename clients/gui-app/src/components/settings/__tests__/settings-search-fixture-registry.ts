import type { IPushPermissionHost } from "@traycer-clients/shared/platform/runner-host";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import type { FeatureSettingsBridge } from "@/lib/desktop-feature-settings";
import type { SettingsAvailabilityContext } from "@/lib/settings/settings-availability";
import type { SettingsSectionId } from "@/lib/settings-sections";
import type { DesktopZoomBridge } from "@/lib/windows/types";

/**
 * Every shell each anchored section's panel is mounted in by the fixture
 * executor (`settings-search-fixtures.test.tsx`), which runs the DOM contract
 * (`assertSettingsSearchTargets`) for each one.
 *
 * Data only — no panel is imported here — so the index test can check the
 * registry itself: every section with an anchored entry must be listed, and
 * every anchored entry must be available in at least one of its section's
 * shells. Without the second rule, an entry whose gate no listed shell turns
 * on would only ever be asserted ABSENT, which a missing row passes too.
 *
 * Each context turns on one gate at a time — every bridge absent, each bridge
 * alone, mobile and not — so an entry left always-available while its row is
 * gated fails the shell whose gate is off.
 *
 * `mobileFooter` is the one member that is not a bridge or a build flag but a
 * stored preference, so the executor has to WRITE it into `layout-store`
 * before it mounts; see `mountInShell`.
 */
export interface SettingsSearchFixtureShell {
  readonly name: string;
  readonly context: SettingsAvailabilityContext;
}

export interface SettingsSearchFixture {
  readonly section: SettingsSectionId;
  /**
   * The host-scope state the executor mounts a host-scoped section under.
   * `"connecting"` is the state where `HostScopeGate` withholds a page's body,
   * so only an element OUTSIDE the gate can be asserted to land; `null` means
   * the section is not host-scoped, or its panel needs no scope to render.
   */
  readonly hostScope: "connecting" | null;
  readonly shells: ReadonlyArray<SettingsSearchFixtureShell>;
}

const FEATURE_SETTINGS: FeatureSettingsBridge = {
  get: () => Promise.resolve({ agentRoles: false }),
  setAgentRolesEnabled: (enabled: boolean) =>
    Promise.resolve({ agentRoles: enabled }),
};

const DESKTOP_ZOOM: DesktopZoomBridge = {
  ladder: [90, 100, 110],
  get: () => Promise.resolve(100),
  set: (percent: number) => Promise.resolve(percent),
  stepIn: () => Promise.resolve(110),
  stepOut: () => Promise.resolve(90),
  reset: () => Promise.resolve(100),
  onChange: () => ({ dispose: () => undefined }),
};

const PUSH_PERMISSION: IPushPermissionHost = {
  get: () => Promise.resolve("granted"),
  request: () => Promise.resolve("granted"),
  openSettings: () => Promise.resolve(),
  onChange: () => ({ dispose: () => undefined }),
};

const SYSTEM_SETTINGS = { open: () => Promise.resolve() };

const BASE_HOST = createFakeRunnerHost({});

function notificationsHost(options: {
  readonly system: boolean;
  readonly push: boolean;
}): SettingsAvailabilityContext {
  return {
    runnerHost: createFakeRunnerHost({
      pushPermission: options.push ? PUSH_PERMISSION : null,
      notifications: {
        ...BASE_HOST.notifications,
        systemSettings: options.system ? SYSTEM_SETTINGS : null,
      },
    }),
    featureSettings: null,
    mobileApp: false,
    mobileFooter: false,
  };
}

const NO_BRIDGES: SettingsAvailabilityContext = {
  runnerHost: null,
  featureSettings: null,
  mobileApp: false,
  mobileFooter: false,
};

export const SETTINGS_SEARCH_FIXTURES = [
  // The checklist's cards always render - an unavailable guide is disabled in
  // place, not withheld - so the replay card's anchor is there with and
  // without a runner host, which is what these two shells assert.
  {
    section: "getting-started",
    hostScope: null,
    shells: [
      { name: "no runner host", context: NO_BRIDGES },
      {
        name: "a runner host",
        context: { ...NO_BRIDGES, runnerHost: createFakeRunnerHost({}) },
      },
    ],
  },
  {
    section: "general",
    hostScope: null,
    shells: [
      { name: "every bridge absent", context: NO_BRIDGES },
      {
        name: "only the feature-settings bridge",
        context: { ...NO_BRIDGES, featureSettings: FEATURE_SETTINGS },
      },
      {
        name: "the installed mobile app",
        context: { ...NO_BRIDGES, mobileApp: true },
      },
    ],
  },
  {
    section: "appearance",
    hostScope: null,
    shells: [
      { name: "no runner host", context: NO_BRIDGES },
      {
        name: "a runner host without the zoom bridge",
        context: { ...NO_BRIDGES, runnerHost: createFakeRunnerHost({}) },
      },
      {
        name: "the zoom bridge",
        context: {
          ...NO_BRIDGES,
          runnerHost: createFakeRunnerHost({ zoom: DESKTOP_ZOOM }),
        },
      },
    ],
  },
  // Layout's shell-level gates are the BUILD and, in the installed mobile app
  // alone, the `Footer status bar` switch: that build draws no footer until it
  // is on, so the group collapses to the switch, its note and the header row -
  // and turning it on hands the page every footer control back EXCEPT
  // Placement, which stays withheld there because the mobile header keeps both
  // controls either way. Three shells, so each of those three answers is
  // asserted rather than two of them being inferred from the third.
  {
    section: "layout",
    hostScope: null,
    // Every shell carries a runner host: the page's host-scoped provider list
    // reads one to resolve the watched host, and no Layout gate turns on it.
    shells: [
      {
        name: "a desktop build",
        context: { ...NO_BRIDGES, runnerHost: createFakeRunnerHost({}) },
      },
      {
        name: "the installed mobile app",
        context: {
          ...NO_BRIDGES,
          runnerHost: createFakeRunnerHost({}),
          mobileApp: true,
        },
      },
      {
        name: "the installed mobile app with the footer on",
        context: {
          ...NO_BRIDGES,
          runnerHost: createFakeRunnerHost({}),
          mobileApp: true,
          mobileFooter: true,
        },
      },
    ],
  },
  {
    section: "opening-behavior",
    hostScope: null,
    shells: [{ name: "every bridge absent", context: NO_BRIDGES }],
  },
  // Every anchored entry on this page (search, browser placement,
  // agent-opened tabs) renders unconditionally; the dev-origins/website-
  // sessions groups are host/data-gated but only `contributesTo: "page"`, so
  // they carry no anchor of their own and need no separate shell to prove.
  {
    section: "browser",
    hostScope: null,
    shells: [{ name: "every bridge absent", context: NO_BRIDGES }],
  },
  {
    section: "app-notifications",
    hostScope: null,
    shells: [
      {
        name: "every bridge absent",
        context: notificationsHost({ system: false, push: false }),
      },
      {
        name: "only the OS notification-settings bridge",
        context: notificationsHost({ system: true, push: false }),
      },
      {
        name: "only the push-permission bridge",
        context: notificationsHost({ system: false, push: true }),
      },
      {
        name: "both bridges",
        context: notificationsHost({ system: true, push: true }),
      },
    ],
  },
  {
    section: "app-diagnostics",
    hostScope: null,
    shells: [
      {
        name: "a runner host with no desktop bridges",
        context: { ...NO_BRIDGES, runnerHost: createFakeRunnerHost({}) },
      },
    ],
  },
  // Permissions is host-scoped, but its tab bar and the Modes tab's app-scoped
  // rows sit outside `HostScopeGate`, so they land while the host is still
  // connecting - the one state where the gated tabs' bodies are withheld.
  {
    section: "permissions",
    hostScope: "connecting",
    shells: [{ name: "a host still connecting", context: NO_BRIDGES }],
  },
  // The Overview is host-scoped too, and its header and tab bar render for
  // every host in every state: each tab body decides for itself what it can
  // show, so the five triggers land while the host is still connecting - the
  // state where no body can read anything. The page reads the runner host for
  // its local-only doctor repairs, hence the one it is mounted with.
  {
    section: "host",
    hostScope: "connecting",
    shells: [
      {
        name: "a host still connecting",
        context: { ...NO_BRIDGES, runnerHost: createFakeRunnerHost({}) },
      },
    ],
  },
] as const satisfies ReadonlyArray<SettingsSearchFixture>;

/** The sections the executor must know how to mount. */
export type SettingsSearchFixtureSection =
  (typeof SETTINGS_SEARCH_FIXTURES)[number]["section"];
