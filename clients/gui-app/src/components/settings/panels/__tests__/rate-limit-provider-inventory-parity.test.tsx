import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderId,
  ProviderProfile,
  ProvidersListResponse,
} from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import { providersListResponseSchema } from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import { HostRuntime } from "@traycer-clients/shared/host-client/host-runtime";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostRuntimeContext } from "@/lib/host";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { AuthService } from "@/lib/auth/auth-service";
import { createAuthBoundHostDirectory } from "@/lib/host/auth-bound-host-directory";
import type { HostDirectoryService } from "@/lib/host/host-directory-service";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { RateLimitPopover } from "@/components/layout/header/rate-limit-popover";
import { ProvidersSettingsPanel } from "@/components/settings/panels/providers-settings-panel";
import type { RateLimitProfileSelection } from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import type { ProviderRateLimitEnvelope } from "@/lib/rate-limits/rate-limit-envelope";
import { NO_EPISODE } from "@/lib/rate-limits/rate-limit-envelope";
import { isRateLimitCapableProvider } from "@/lib/rate-limit-providers";
import { queryKeys } from "@/lib/query-keys";
import {
  NO_NOTICES,
  NO_OVERRIDES,
  NO_REVIEW,
  PersonalPageContext,
} from "@/components/settings/personal/personal-page-context";

const HOST_ID = "provider-inventory-host";
const HOST_NAME = "dev-box";
const UNREADABLE_REASON = "Profile row uses an unsupported or invalid shape";

const spyState = vi.hoisted(() => ({
  scope: null as HostScope | null,
}));

vi.mock(
  "@/components/settings/host-scope/use-host-scope",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/settings/host-scope/use-host-scope")
      >();
    return {
      ...actual,
      usePersonalHostScope: () => {
        if (spyState.scope === null) {
          throw new Error("The inventory parity fixture has no host scope.");
        }
        return spyState.scope;
      },
    };
  },
);

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: () => undefined }),
  useSystemOverlayActive: () => false,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useRouterState: (args: {
      select: (state: {
        location: { pathname: string; search: string };
      }) => unknown;
    }) => args.select({ location: { pathname: "/settings", search: "" } }),
    useNavigate: () => () => undefined,
  };
});

interface ProfileFixture {
  readonly profileId: string;
  readonly kind?: "ambient" | "managed";
  readonly label: string;
  readonly authStatus?:
    | "authenticated"
    | "configured"
    | "unauthenticated"
    | "unavailable"
    | "unknown";
  readonly usageUpdatedAt?: number | null;
  readonly fields?: Readonly<Record<string, unknown>>;
}

function profileFixture(input: ProfileFixture): Record<string, unknown> {
  return {
    profileId: input.profileId,
    enabled: true,
    kind: input.kind ?? "managed",
    authType: "oauth",
    label: input.label,
    auth: {
      status: input.authStatus ?? "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: input.usageUpdatedAt ?? null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
    ...input.fields,
  };
}

function providerFixture(
  providerId: ProviderId,
  usageReporting: boolean | undefined,
  profiles: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: {
      ...DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
      supportedTabs: ["general", "usage"],
    },
    profiles,
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    ...(usageReporting === undefined ? {} : { usageReporting }),
  };
}

function providersResponse(oldHost: boolean): ProvidersListResponse {
  const reporting = (value: boolean): boolean | undefined =>
    oldHost ? undefined : value;
  const qwenProfiles = [
    profileFixture({
      profileId: "ambient",
      kind: "ambient",
      label: "Qwen's own login on dev-box",
    }),
    profileFixture({
      profileId: "configured-alias",
      label: "Configured alias",
      authStatus: "configured",
    }),
    profileFixture({
      profileId: "native-key-profile",
      label: "Native key account",
      fields: { apiKey: { supported: true, configured: true } },
    }),
    profileFixture({
      profileId: "brokered-profile",
      label: "Brokered account",
      fields: {
        credentialHome: {
          homeAddress: "harness-accounts/qwen/brokered-profile",
          bindingVersion: 1,
          materialRevision: 1,
          custodyVersion: 1,
          custodyClass: "brokered",
          environmentPresence: null,
          handoffEnvironmentId: null,
          materialFingerprint: null,
          observation: null,
          materialMatchesBinding: "yes",
          standing: {
            material: "stale",
            repairDeadline: null,
            familyVersion: null,
            authority: "custodian",
            cause: "session expired",
            observation: {
              source: "custodian",
              status: "answered",
              capturedAt: 1_800_000_000_000,
            },
          },
        },
      },
    }),
    profileFixture({
      profileId: "revoking-profile",
      label: "Revoking account",
      fields: {
        presence: { kind: "revoking", cause: "host-left-environment" },
      },
    }),
    {
      profileId: "unreadable-profile",
      label: "Unreadable account",
      kind: "managed",
      auth: "malformed-auth-row",
    },
    profileFixture({
      profileId: "unavailable-profile",
      label: "Unavailable account",
      authStatus: "unavailable",
    }),
    profileFixture({
      profileId: "unknown-profile",
      label: "Unknown account",
      authStatus: "unknown",
    }),
    profileFixture({
      profileId: "signed-out-cached-profile",
      label: "Signed-out cached account",
      authStatus: "unauthenticated",
      usageUpdatedAt: 1_800_000_000_000,
    }),
  ];
  return providersListResponseSchema.parse({
    providers: [
      providerFixture("qwen", reporting(true), qwenProfiles),
      providerFixture("opencode", reporting(true), [
        profileFixture({
          profileId: "mapped-unavailable-profile",
          label: "Mapped unavailable account",
          authStatus: "unavailable",
        }),
        profileFixture({
          profileId: "mapped-unknown-profile",
          label: "Mapped unknown account",
          authStatus: "unknown",
        }),
        profileFixture({
          profileId: "mapped-signed-out-profile",
          label: "Mapped signed-out account",
          authStatus: "unauthenticated",
          usageUpdatedAt: 1_800_000_000_000,
        }),
      ]),
      providerFixture("codex", reporting(false), [
        profileFixture({
          profileId: "settings-only-profile",
          label: "Settings-only account",
        }),
      ]),
    ],
    native: null,
  });
}

interface Harness {
  readonly queryClient: QueryClient;
  readonly runnerHost: MockRunnerHost;
  readonly auth: AuthService;
  readonly directory: HostDirectoryService;
  readonly runtime: HostRuntime<HostRpcRegistry>;
  readonly binding: HostRuntimeBinding<HostRpcRegistry>;
  readonly scope: HostScope;
  readonly providersListCalls: { value: number };
  readonly rateLimitUsageRequests: Array<ProviderId | undefined>;
}

async function createHarness(
  response: ProvidersListResponse,
): Promise<Harness> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: {
      hostId: HOST_ID,
      websocketUrl: "ws://127.0.0.1:4917/rpc",
      version: "1.4.2",
      pid: 4242,
      systemHostName: HOST_NAME,
      displayName: HOST_NAME,
      availability: "available",
    },
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: true,
    traycerCli: null,
  });
  const auth = new AuthService({ runnerHost });
  const directory = createAuthBoundHostDirectory({
    auth,
    runnerHost,
    remoteFetcher: () => Promise.resolve({ kind: "hosts", entries: [] }),
    localHostIdSeeder: () => Promise.resolve(HOST_ID),
    onRegistryPollTick: null,
  });
  await directory.startSeeded();
  const providersListCalls = { value: 0 };
  const rateLimitUsageRequests: Array<ProviderId | undefined> = [];
  let requestSeq = 0;
  const runtime = new HostRuntime<HostRpcRegistry>({
    runnerHost,
    registry: hostRpcRegistry,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `inventory-${++requestSeq}`,
      handlers: {
        "providers.list": () => {
          providersListCalls.value += 1;
          return response;
        },
        "host.getRateLimitUsage": (params) => {
          rateLimitUsageRequests.push(params.providerId);
          return {
            totalTokens: 0,
            remainingTokens: 0,
            providerRateLimits: null,
          };
        },
      },
    }),
    requestContextProvider: auth.getRequestContextProvider(),
    directory,
    invalidator: createHostQueryInvalidator(queryClient),
    schedulingPolicy: hostRpcSchedulingPolicy,
    authorityRegistry: null,
    requestCoordinator: null,
    selectedHostId: () => HOST_ID,
    connectionRegistry: null,
  });
  runtime.hostClient.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const hostClient = runtime.hostClient.createRequesterForHostId(HOST_ID);
  const host = hostScopeOptionFixture({ hostId: HOST_ID, name: HOST_NAME });
  const scope = hostScopeFixture({
    status: "ready",
    hostId: HOST_ID,
    host,
    client: hostClient,
  });
  const binding: HostRuntimeBinding<HostRpcRegistry> = {
    runtime,
    hostClient,
    directory,
    auth,
    hostId: HOST_ID,
  };
  return {
    queryClient,
    runnerHost,
    auth,
    directory,
    runtime,
    binding,
    scope,
    providersListCalls,
    rateLimitUsageRequests,
  };
}

const builtHarnesses: Harness[] = [];

afterEach(() => {
  cleanup();
  for (const harness of builtHarnesses.splice(0)) {
    harness.runtime.dispose();
    harness.directory.dispose();
    harness.auth.dispose();
  }
  spyState.scope = null;
  useSettingsEnvironmentPickStore.setState({ pick: null });
  useProvidersFocusStore.setState({
    focusHarnessId: null,
    focusHostId: null,
    focusTargetHostId: null,
    focusProfileId: null,
    startSignIn: false,
    focusTab: null,
  });
});

function openCodeLastGoodEnvelope(): ProviderRateLimitEnvelope {
  const lastGood = {
    provider: "opencode",
    available: true,
    credentialGeneration: "inventory-cache-generation",
    fiveHour: {
      usedPercent: 4,
      resetsAt: Date.now() + 60 * 60 * 1000,
      durationMinutes: 300,
      status: "ok",
    },
    weekly: {
      usedPercent: 8,
      resetsAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      durationMinutes: 7 * 24 * 60,
      status: "ok",
    },
    monthly: {
      usedPercent: 12,
      resetsAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      durationMinutes: 30 * 24 * 60,
      status: "ok",
    },
  } as const;
  return {
    latest: lastGood,
    lastGood,
    lastGoodAt: Date.now(),
    lastFailureAt: null,
    credentialGeneration: "inventory-cache-generation",
    episode: NO_EPISODE,
  };
}

function requireProvider(
  response: ProvidersListResponse,
  providerId: ProviderId,
): ProvidersListResponse["providers"][number] {
  const provider = response.providers.find(
    (candidate) => candidate.providerId === providerId,
  );
  if (provider === undefined) {
    throw new Error(`The ${providerId} provider fixture is incomplete.`);
  }
  return provider;
}

interface RenderedProfileInventoryRow {
  readonly providerId: string;
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly authStatus: string;
  readonly standing: string;
  readonly presence: string;
  readonly readability: string;
}

interface SettingsProviderRailEntry {
  readonly enabled: boolean;
  readonly button: HTMLElement;
}

function requiredAttribute(element: Element, name: string): string {
  const value = element.getAttribute(name);
  if (value === null) {
    throw new Error(`Rendered inventory element is missing ${name}.`);
  }
  return value;
}

function htmlElements(root: ParentNode, selector: string): HTMLElement[] {
  return [...root.querySelectorAll(selector)].map((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error(`Expected an HTMLElement for selector ${selector}.`);
    }
    return element;
  });
}

function renderedProfileInventoryRow(
  element: HTMLElement,
  providerId: string,
): RenderedProfileInventoryRow {
  return {
    providerId,
    id: requiredAttribute(element, "data-provider-profile-id"),
    kind: requiredAttribute(element, "data-provider-profile-kind"),
    label: requiredAttribute(element, "data-provider-profile-label"),
    authStatus: requiredAttribute(element, "data-provider-profile-auth-status"),
    standing: requiredAttribute(element, "data-provider-profile-standing"),
    presence: requiredAttribute(element, "data-provider-profile-presence"),
    readability: requiredAttribute(
      element,
      "data-provider-profile-readability",
    ),
  };
}

function settingsProviderRail(
  settings: HTMLElement,
): Map<string, SettingsProviderRailEntry> {
  const providers = new Map<string, SettingsProviderRailEntry>();
  for (const button of htmlElements(
    settings,
    "button[data-settings-provider-id]",
  )) {
    const providerId = requiredAttribute(button, "data-settings-provider-id");
    const enabledValue = requiredAttribute(
      button,
      "data-settings-provider-enabled",
    );
    if (enabledValue !== "true" && enabledValue !== "false") {
      throw new Error(
        `Settings provider ${providerId} has invalid enabled data.`,
      );
    }
    const enabled = enabledValue === "true";
    const previous = providers.get(providerId);
    if (previous !== undefined) {
      expect(previous.enabled).toBe(enabled);
      continue;
    }
    providers.set(providerId, { enabled, button });
  }
  return providers;
}

function selectedSettingsProfileSection(
  settings: HTMLElement,
  providerId: string,
): HTMLElement {
  const section = settings.querySelector(
    `section[data-settings-provider-id="${providerId}"][data-provider-profile-id]`,
  );
  if (!(section instanceof HTMLElement)) {
    throw new Error(`Settings has no selected profile row for ${providerId}.`);
  }
  return section;
}

function selectedSettingsProfile(
  settings: HTMLElement,
  providerId: string,
): RenderedProfileInventoryRow {
  return renderedProfileInventoryRow(
    selectedSettingsProfileSection(settings, providerId),
    providerId,
  );
}

function profileMenuTrigger(
  settings: HTMLElement,
  providerId: string,
): HTMLElement {
  const trigger = selectedSettingsProfileSection(
    settings,
    providerId,
  ).querySelector('button[aria-label*=" profile:"]');
  if (!(trigger instanceof HTMLElement)) {
    throw new Error(`Settings has no profile menu trigger for ${providerId}.`);
  }
  return trigger;
}

function assertManagedProfileLabelIsVisible(
  settings: HTMLElement,
  providerId: string,
  profile: RenderedProfileInventoryRow,
): void {
  if (profile.kind === "ambient") return;
  const trigger = profileMenuTrigger(settings, providerId);
  const visibleLabel = `${trigger.getAttribute("aria-label") ?? ""} ${trigger.textContent}`;
  expect(visibleLabel).toContain(profile.label);
}

function settingsProfileMenuOptions(menu: HTMLElement): Array<{
  readonly label: string;
  readonly disabled: boolean;
  readonly current: boolean;
}> {
  return htmlElements(
    menu,
    '[role="group"][aria-label$=" profile controls"]',
  ).map((group) => {
    const item = group.querySelector('[role="menuitem"]');
    if (!(item instanceof HTMLElement)) {
      throw new Error(
        "A profile controls group has no selectable profile row.",
      );
    }
    return {
      label: requiredAttribute(item, "aria-label"),
      disabled:
        item.getAttribute("aria-disabled") === "true" ||
        item.hasAttribute("data-disabled"),
      current: item.getAttribute("aria-current") === "true",
    };
  });
}

async function collectSettingsProfileInventory(
  settings: HTMLElement,
  user: UserEvent,
): Promise<{
  readonly providers: Map<string, SettingsProviderRailEntry>;
  readonly profiles: Map<string, ReadonlyArray<RenderedProfileInventoryRow>>;
}> {
  const providers = settingsProviderRail(settings);
  const profilesByProvider = new Map<
    string,
    ReadonlyArray<RenderedProfileInventoryRow>
  >();
  const initiallySelected = settings.querySelector(
    "section[data-settings-provider-id][data-provider-profile-id]",
  );
  if (!(initiallySelected instanceof HTMLElement)) {
    throw new Error("Settings did not render its initially selected profile.");
  }
  const initialProviderId = requiredAttribute(
    initiallySelected,
    "data-settings-provider-id",
  );
  const initialRow = renderedProfileInventoryRow(
    initiallySelected,
    initialProviderId,
  );
  profilesByProvider.set(initialProviderId, [initialRow]);
  assertManagedProfileLabelIsVisible(settings, initialProviderId, initialRow);
  for (const [providerId, entry] of providers) {
    if (entry.button.getAttribute("aria-current") !== "true") {
      await user.click(entry.button);
    }
    const rows = [...(profilesByProvider.get(providerId) ?? [])];
    const currentRow = selectedSettingsProfile(settings, providerId);
    if (!rows.some((row) => row.id === currentRow.id)) rows.push(currentRow);
    assertManagedProfileLabelIsVisible(settings, providerId, currentRow);
    const section = selectedSettingsProfileSection(settings, providerId);
    const trigger = section.querySelector('button[aria-label*=" profile:"]');
    if (trigger instanceof HTMLElement) {
      await user.click(trigger);
      const menu = screen.getByRole("menu");
      const options = settingsProfileMenuOptions(menu);
      expect(new Set(options.map((option) => option.label)).size).toBe(
        options.length,
      );
      await user.click(profileMenuTrigger(settings, providerId));
      for (const option of options) {
        if (option.current) continue;
        if (option.disabled) {
          expect(rows.some((row) => row.readability !== "null")).toBe(true);
          continue;
        }
        await user.click(profileMenuTrigger(settings, providerId));
        const currentMenu = screen.getByRole("menu");
        await user.click(
          within(currentMenu).getByRole("menuitem", { name: option.label }),
        );
        const selectedProfile = selectedSettingsProfile(settings, providerId);
        assertManagedProfileLabelIsVisible(
          settings,
          providerId,
          selectedProfile,
        );
        rows.push(selectedProfile);
      }
      expect(rows).toHaveLength(options.length);
    }
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    profilesByProvider.set(providerId, rows);
  }
  return { providers, profiles: profilesByProvider };
}

function collectPopoverProfileInventory(
  popover: HTMLElement,
): Map<string, ReadonlyArray<RenderedProfileInventoryRow>> {
  const providers = new Map<
    string,
    ReadonlyArray<RenderedProfileInventoryRow>
  >();
  for (const group of htmlElements(popover, "[data-usage-provider-id]")) {
    const providerId = requiredAttribute(group, "data-usage-provider-id");
    if (providers.has(providerId)) {
      throw new Error(
        `Usage rendered more than one provider group for ${providerId}.`,
      );
    }
    const rows = htmlElements(group, "[data-provider-profile-id]").map(
      (card) => {
        const row = renderedProfileInventoryRow(card, providerId);
        expect(within(card).getByText(row.label, { exact: true })).toBeTruthy();
        return row;
      },
    );
    providers.set(providerId, rows);
  }
  return providers;
}

function expectedUsageProviderIds(
  response: ProvidersListResponse,
  settingsProviders: ReadonlyMap<string, SettingsProviderRailEntry>,
): string[] {
  const capability = new Map<string, boolean>(
    response.providers.map((provider) => [
      provider.providerId,
      provider.usageReporting ??
        isRateLimitCapableProvider(provider.providerId),
    ]),
  );
  return [...settingsProviders]
    .filter(
      ([providerId, entry]) =>
        entry.enabled && capability.get(providerId) === true,
    )
    .map(([providerId]) => providerId)
    .sort();
}

function sortedInventoryRows(
  rows: ReadonlyArray<RenderedProfileInventoryRow>,
): RenderedProfileInventoryRow[] {
  return [...rows].sort((left, right) => left.id.localeCompare(right.id));
}

function assertRenderedInventoryParity(
  response: ProvidersListResponse,
  settingsProviders: ReadonlyMap<string, SettingsProviderRailEntry>,
  settingsProfiles: ReadonlyMap<
    string,
    ReadonlyArray<RenderedProfileInventoryRow>
  >,
  popoverProfiles: ReadonlyMap<
    string,
    ReadonlyArray<RenderedProfileInventoryRow>
  >,
): void {
  const responseProviderIds = response.providers
    .map((provider) => provider.providerId)
    .sort();
  expect([...settingsProviders.keys()].sort()).toEqual(responseProviderIds);
  const expectedProviderIds = expectedUsageProviderIds(
    response,
    settingsProviders,
  );
  const actualProviderIds = [...popoverProfiles.keys()].sort();
  expect(actualProviderIds).toEqual(expectedProviderIds);
  expect(popoverProfiles.size).toBe(expectedProviderIds.length);
  for (const providerId of expectedProviderIds) {
    const settingsRows = settingsProfiles.get(providerId);
    const popoverRows = popoverProfiles.get(providerId);
    if (settingsRows === undefined || popoverRows === undefined) {
      throw new Error(`A rendered profile inventory is missing ${providerId}.`);
    }
    expect(sortedInventoryRows(popoverRows)).toEqual(
      sortedInventoryRows(settingsRows),
    );
  }
}

function assertParserRetainsProfileFacts(
  profiles: ReadonlyArray<ProviderProfile>,
): void {
  const unreadable = profiles.find(
    (profile) => profile.profileId === "unreadable-profile",
  );
  expect(unreadable?.readability?.kind).toBe("unreadable");
  expect(unreadable?.enabled).toBe(false);

  const nativeKeyProfile = profiles.find(
    (profile) => profile.profileId === "native-key-profile",
  );
  expect(nativeKeyProfile?.apiKey).toEqual({
    supported: true,
    configured: true,
  });

  const brokeredProfile = profiles.find(
    (profile) => profile.profileId === "brokered-profile",
  );
  expect(brokeredProfile?.credentialHome).toMatchObject({
    custodyClass: "brokered",
    standing: { material: "stale", cause: "session expired" },
  });
}

function assertMappedUnhealthyProfilesRetainUsage(popover: HTMLElement): void {
  const profiles = [
    ["mapped-unavailable-profile", "Unavailable", "unavailable"],
    ["mapped-unknown-profile", "Unknown", "unknown"],
    ["mapped-signed-out-profile", "Signed out", "unauthenticated"],
  ] as const;
  for (const [profileId, authLabel, authStatus] of profiles) {
    const card = popover.querySelector(
      `[data-usage-provider-id="opencode"] [data-provider-profile-id="${profileId}"]`,
    );
    if (!(card instanceof HTMLElement)) {
      throw new Error(`Usage did not render OpenCode account ${profileId}.`);
    }
    expect(card.getAttribute("data-provider-profile-auth-status")).toBe(
      authStatus,
    );
    expect(within(card).getByText(authLabel)).toBeTruthy();
    expect(within(card).getByText("4% used")).toBeTruthy();
  }
}

function assertUnreadableProfileNotice(
  popover: HTMLElement,
  settings: HTMLElement,
): void {
  const notice = `Unreadable profile: ${UNREADABLE_REASON}`;
  expect(within(popover).getByText(notice)).toBeTruthy();
  const summary = settings.querySelector(
    '[data-slot="profile-summary-actions"]',
  );
  if (!(summary instanceof HTMLElement)) {
    throw new Error("Settings did not render the selected profile summary.");
  }
  expect(within(summary).getByText(notice)).toBeTruthy();
}

interface MountedInventoryConsumers {
  readonly harness: Harness;
  readonly popover: HTMLElement;
  readonly settings: HTMLElement;
}

async function mountInventoryConsumers(
  response: ProvidersListResponse,
): Promise<MountedInventoryConsumers> {
  const harness = await createHarness(response);
  builtHarnesses.push(harness);
  const openCode = response.providers.find(
    (provider) => provider.providerId === "opencode",
  );
  if (openCode !== undefined) {
    const cachedUsage = openCodeLastGoodEnvelope();
    for (const profile of openCode.profiles) {
      harness.queryClient.setQueryData(
        queryKeys.hostMethod<HostRpcRegistry, "host.getRateLimitUsage">(
          HOST_ID,
          "host.getRateLimitUsage",
          {
            accountContext: DEFAULT_ACCOUNT_CONTEXT,
            providerId: "opencode",
            profileId: profile.profileId,
          },
        ),
        cachedUsage,
        { updatedAt: Date.now() },
      );
    }
  }
  spyState.scope = harness.scope;
  useSettingsEnvironmentPickStore.setState({
    pick: { kind: "local", hostId: HOST_ID, hostName: HOST_NAME },
  });
  useProvidersFocusStore.setState({
    focusHarnessId: "qwen",
    focusHostId: null,
    focusTargetHostId: null,
    focusProfileId: "unreadable-profile",
    startSignIn: false,
    focusTab: "usage",
  });

  const profileSelection: RateLimitProfileSelection = {
    shownProfiles: {},
    lastProfileByHarness: {},
  };
  render(
    <RunnerHostProvider runnerHost={harness.runnerHost}>
      <QueryClientProvider client={harness.queryClient}>
        <HostRuntimeContext.Provider value={harness.binding}>
          <TooltipProvider>
            <Popover open>
              <PopoverTrigger asChild>
                <button type="button">Open usage</button>
              </PopoverTrigger>
              <RateLimitPopover
                onClose={() => undefined}
                profileSelection={profileSelection}
                scope={harness.scope}
                hasExplicitPick={false}
                side="bottom"
                align="end"
              />
            </Popover>
            <div data-testid="providers-settings-panel">
              <PersonalPageContext.Provider
                value={{
                  section: "providers",
                  pick: { kind: "local", hostId: HOST_ID, hostName: HOST_NAME },
                  state: {
                    kind: "ready",
                    status: environmentStatusFixture({}),
                  },
                  line: null,
                  hostName: HOST_NAME,
                  localOverrides: NO_OVERRIDES,
                  hostId: HOST_ID,
                  client: harness.binding.hostClient,
                  notices: NO_NOTICES,
                  review: NO_REVIEW,
                }}
              >
                <ProvidersSettingsPanel />
              </PersonalPageContext.Provider>
            </div>
          </TooltipProvider>
        </HostRuntimeContext.Provider>
      </QueryClientProvider>
    </RunnerHostProvider>,
  );

  const popover = await screen.findByRole("dialog", { name: "Usage limits" });
  const settings = screen.getByTestId("providers-settings-panel");
  await waitFor(() => {
    expect(
      settings.querySelectorAll("button[data-settings-provider-id]").length,
    ).toBeGreaterThan(0);
    expect(harness.providersListCalls.value).toBe(1);
  });
  return { harness, popover, settings };
}

describe("provider inventory shared by Usage and Settings", () => {
  it("renders all reporting inventory rows from the shared host response", async () => {
    const response = providersResponse(false);
    const qwen = requireProvider(response, "qwen");
    assertParserRetainsProfileFacts(qwen.profiles);
    const { harness, popover, settings } =
      await mountInventoryConsumers(response);

    assertMappedUnhealthyProfilesRetainUsage(popover);
    assertUnreadableProfileNotice(popover, settings);
    const { providers, profiles } = await collectSettingsProfileInventory(
      settings,
      userEvent.setup(),
    );
    const popoverProfiles = collectPopoverProfileInventory(popover);
    assertRenderedInventoryParity(
      response,
      providers,
      profiles,
      popoverProfiles,
    );

    expect(providers.has("codex")).toBe(true);
    expect(profiles.get("codex")).toHaveLength(1);
    expect(popoverProfiles.has("codex")).toBe(false);
    expect(popoverProfiles.has("qwen")).toBe(true);
    expect(popoverProfiles.has("opencode")).toBe(true);
    expect(harness.rateLimitUsageRequests).not.toContain("qwen");
    for (const group of htmlElements(popover, "[data-usage-provider-id]")) {
      expect(
        within(group).queryByText("Usage reporting unconfirmed."),
      ).toBeNull();
    }
    await waitFor(() => expect(harness.providersListCalls.value).toBe(1));
  });

  it("marks mapped provider rows unconfirmed for an old enum-only host response", async () => {
    const response = providersResponse(true);
    expect(
      response.providers.every(
        (provider) => provider.usageReporting === undefined,
      ),
    ).toBe(true);
    const { harness, popover, settings } =
      await mountInventoryConsumers(response);

    const { providers, profiles } = await collectSettingsProfileInventory(
      settings,
      userEvent.setup(),
    );
    const popoverProfiles = collectPopoverProfileInventory(popover);
    assertRenderedInventoryParity(
      response,
      providers,
      profiles,
      popoverProfiles,
    );

    expect(providers.has("qwen")).toBe(true);
    expect(popoverProfiles.has("qwen")).toBe(false);
    expect([...popoverProfiles.keys()].sort()).toEqual(["codex", "opencode"]);
    for (const group of htmlElements(popover, "[data-usage-provider-id]")) {
      expect(
        within(group).getByText("Usage reporting unconfirmed."),
      ).toBeTruthy();
    }
    await waitFor(() => expect(harness.providersListCalls.value).toBe(1));
  });
});
