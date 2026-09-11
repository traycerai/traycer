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
 */
export interface SettingsSearchFixtureShell {
  readonly name: string;
  readonly context: SettingsAvailabilityContext;
}

export interface SettingsSearchFixture {
  readonly section: SettingsSectionId;
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
  };
}

const NO_BRIDGES: SettingsAvailabilityContext = {
  runnerHost: null,
  featureSettings: null,
  mobileApp: false,
};

export const SETTINGS_SEARCH_FIXTURES = [
  {
    section: "general",
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
  {
    section: "opening-behavior",
    shells: [{ name: "every bridge absent", context: NO_BRIDGES }],
  },
  {
    section: "app-notifications",
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
    shells: [
      {
        name: "a runner host with no desktop bridges",
        context: { ...NO_BRIDGES, runnerHost: createFakeRunnerHost({}) },
      },
    ],
  },
] as const satisfies ReadonlyArray<SettingsSearchFixture>;

/** The sections the executor must know how to mount. */
export type SettingsSearchFixtureSection =
  (typeof SETTINGS_SEARCH_FIXTURES)[number]["section"];
