import { useEffect } from "react";
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
import {
  PROVIDER_DISPLAY_NAMES,
  providersListResponseSchema,
} from "@traycer/protocol/host/provider-schemas";
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
import {
  useVisibleRateLimitProviders,
  type VisibleRateLimitProvider,
} from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import type { ProviderRateLimitEnvelope } from "@/lib/rate-limits/rate-limit-envelope";
import { NO_EPISODE } from "@/lib/rate-limits/rate-limit-envelope";
import { queryKeys } from "@/lib/query-keys";
import {
  profileAuthStatusText,
  profileDisplayLabel,
  profileInventoryNotice,
} from "@/components/providers/provider-profile-model";
import {
  NO_NOTICES,
  NO_OVERRIDES,
  NO_REVIEW,
  PersonalPageContext,
} from "@/components/settings/personal/personal-page-context";

const HOST_ID = "provider-inventory-host";
const HOST_NAME = "dev-box";
const UNREADABLE_REASON =
  "Profile row uses an unsupported or invalid shape";

interface ProviderProfilesSnapshot {
  readonly providerId: ProviderId;
  readonly profiles: ReadonlyArray<ProviderProfile>;
}

const spyState = vi.hoisted(() => ({
  scope: null as HostScope | null,
  settingsProfiles: [] as ProviderProfilesSnapshot[],
  visibleProviders: null as ReadonlyArray<VisibleRateLimitProvider> | null,
}));

vi.mock("@/components/settings/host-scope/use-host-scope", async (importOriginal) => {
  const actual = await importOriginal<
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
});

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
      select: (state: { location: { pathname: string; search: string } }) => unknown;
    }) => args.select({ location: { pathname: "/settings", search: "" } }),
    useNavigate: () => () => undefined,
  };
});

function VisibleRateLimitProviderRecorder(): null {
  const providers = useVisibleRateLimitProviders();
  useEffect(() => {
    spyState.visibleProviders = providers;
  }, [providers]);
  return null;
}

// This wrapper records the actual props and still renders the real Settings
// consumer. It observes the parsed inventory without replacing its row UI.
vi.mock("@/components/settings/panels/provider-profile-scoped-section", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/components/settings/panels/provider-profile-scoped-section")
  >();
  return {
    ...actual,
    ProviderProfileScopedSection: (
      props: Parameters<typeof actual.ProviderProfileScopedSection>[0],
    ) => {
      spyState.settingsProfiles.push({
        providerId: props.state.providerId,
        profiles: [...props.state.profiles],
      });
      return <actual.ProviderProfileScopedSection {...props} />;
    },
  };
});

interface ProfileFixture {
  readonly profileId: string;
  readonly kind?: "ambient" | "managed";
  readonly label: string;
  readonly authStatus?: "authenticated" | "configured" | "unauthenticated" | "unavailable" | "unknown";
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
  usageReporting: boolean,
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
    usageReporting,
  };
}

function providersResponse(): ProvidersListResponse {
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
      providerFixture("qwen", true, qwenProfiles),
      providerFixture("opencode", true, [
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
      providerFixture("codex", false, [
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
}

async function createHarness(response: ProvidersListResponse): Promise<Harness> {
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
  spyState.settingsProfiles = [];
  spyState.visibleProviders = null;
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

function profileInventory(profiles: ReadonlyArray<ProviderProfile>) {
  return profiles.map((profile) => ({
    id: profile.profileId,
    kind: profile.kind,
    label: profileDisplayLabel(profile),
    authStatus: profile.auth.status,
    standing: profile.credentialHome?.standing ?? null,
    notice: profileInventoryNotice(profile),
  }));
}

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

function latestSettingsSnapshot(
  providerId: ProviderId,
): ProviderProfilesSnapshot {
  const snapshot = [...spyState.settingsProfiles]
    .reverse()
    .find((candidate) => candidate.providerId === providerId);
  if (snapshot === undefined) {
    throw new Error(`Settings did not render ${providerId}'s profile section.`);
  }
  return snapshot;
}

function visibleSnapshot(providerId: ProviderId): VisibleRateLimitProvider {
  const snapshot = spyState.visibleProviders?.find(
    (candidate) => candidate.providerId === providerId,
  );
  if (snapshot === undefined) {
    throw new Error(`The real visible-provider hook did not return ${providerId}.`);
  }
  return snapshot;
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

function assertProfileInventoryParity(
  sourceProfiles: ReadonlyArray<ProviderProfile>,
  settingsProfiles: ReadonlyArray<ProviderProfile>,
  visibleProfiles: ReadonlyArray<ProviderProfile>,
): void {
  const settingsInventory = profileInventory(settingsProfiles);
  expect(settingsInventory).toEqual(profileInventory(sourceProfiles));
  expect(profileInventory(visibleProfiles)).toEqual(settingsInventory);
}

function assertPopoverInventoryCards(
  popover: HTMLElement,
  profiles: ReadonlyArray<ProviderProfile>,
): void {
  for (const profile of profiles) {
    const profileId = profile.kind === "ambient" ? "" : profile.profileId;
    const card = popover.querySelector(
      `[data-testid="rate-limit-profile-card-qwen-${profileId}"]`,
    );
    expect(card).not.toBeNull();
    if (card === null) continue;
    expect(within(card).getByText(profileDisplayLabel(profile))).toBeTruthy();
    const notice =
      profileInventoryNotice(profile) ?? profileAuthStatusText(profile);
    expect(within(card).getByText(notice)).toBeTruthy();
  }
}

function assertMappedUnhealthyProfilesRetainUsage(popover: HTMLElement): void {
  const profiles = [
    ["mapped-unavailable-profile", "Unavailable"],
    ["mapped-unknown-profile", "Unknown"],
    ["mapped-signed-out-profile", "Signed out"],
  ] as const;
  for (const [profileId, authLabel] of profiles) {
    const card = within(popover).getByTestId(
      `rate-limit-profile-card-opencode-${profileId}`,
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
  const summary = settings.querySelector('[data-slot="profile-summary-actions"]');
  expect(summary).not.toBeNull();
  if (summary === null) {
    throw new Error("Settings did not render the selected profile summary.");
  }
  expect(within(summary).getByText(notice)).toBeTruthy();
}

async function selectAndAssertQwenProfiles(
  settings: HTMLElement,
  profiles: ReadonlyArray<ProviderProfile>,
  user: UserEvent,
): Promise<void> {
  const trigger = within(settings).getByRole("button", {
    name: /^Qwen Code profile:/,
  });
  await user.click(trigger);
  const menu = screen.getByRole("menu");
  for (const profile of profiles) {
    const label =
      profile.kind === "ambient"
        ? `${PROVIDER_DISPLAY_NAMES.qwen}'s own login on ${HOST_NAME}`
        : profileDisplayLabel(profile);
    expect(within(menu).getByText(label)).toBeTruthy();
  }
  await user.click(trigger);

  for (const profile of profiles.filter(
    (candidate) => candidate.enabled && candidate.profileId !== "unreadable-profile",
  )) {
    await user.click(trigger);
    const label =
      profile.kind === "ambient"
        ? `${PROVIDER_DISPLAY_NAMES.qwen}'s own login on ${HOST_NAME}`
        : profileDisplayLabel(profile);
    const profileLabel = within(screen.getByRole("menu")).getByText(label);
    const item = profileLabel.closest('[role="menuitem"]');
    if (item === null) {
      throw new Error(`The profile menu item for ${profile.profileId} is missing.`);
    }
    await user.click(item);
    expect(trigger.getAttribute("aria-label")).toContain(label);
    const notice = profileInventoryNotice(profile);
    if (notice === null) continue;
    const summary = settings.querySelector('[data-slot="profile-summary-actions"]');
    expect(summary).not.toBeNull();
    if (summary === null) {
      throw new Error("Settings did not render the selected profile summary.");
    }
    expect(within(summary).getByText(notice)).toBeTruthy();
  }
}

async function selectCodexAndAssertSettingsOnlyProfile(
  settings: HTMLElement,
  codex: ProvidersListResponse["providers"][number],
  user: UserEvent,
): Promise<void> {
  const codexProviderButton = within(settings).getAllByRole("button", {
    name: /^Codex\d+ profile$/,
  }).at(0);
  if (codexProviderButton === undefined) {
    throw new Error("Settings did not render Codex in the provider rail.");
  }
  await user.click(codexProviderButton);
  expect(
    within(settings).getByRole("button", {
      name: "Codex profile: Settings-only account",
    }),
  ).toBeTruthy();
  expect(
    latestSettingsSnapshot("codex").profiles.map((profile) => profile.profileId),
  ).toEqual(codex.profiles.map((profile) => profile.profileId));
}

describe("provider inventory shared by Usage and Settings", () => {
  it("renders the parsed host inventory in both consumers and fetches it once", async () => {
    const response = providersResponse();
    const qwen = requireProvider(response, "qwen");
    const codex = requireProvider(response, "codex");
    const openCode = requireProvider(response, "opencode");
    assertParserRetainsProfileFacts(qwen.profiles);

    const harness = await createHarness(response);
    builtHarnesses.push(harness);
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
    const settingsProfiles = (
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
    );
    render(
      <RunnerHostProvider runnerHost={harness.runnerHost}>
        <QueryClientProvider client={harness.queryClient}>
          <HostRuntimeContext.Provider value={harness.binding}>
            <TooltipProvider>
              <VisibleRateLimitProviderRecorder />
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
              {settingsProfiles}
            </TooltipProvider>
          </HostRuntimeContext.Provider>
        </QueryClientProvider>
      </RunnerHostProvider>,
    );

    const popover = await screen.findByRole("dialog", { name: "Usage limits" });
    const settings = screen.getByTestId("providers-settings-panel");
    await waitFor(() => {
      expect(
        spyState.settingsProfiles.some((snapshot) => snapshot.providerId === "qwen"),
      ).toBe(true);
      expect(
        spyState.visibleProviders?.some((provider) => provider.providerId === "qwen"),
      ).toBe(true);
      expect(harness.providersListCalls.value).toBe(1);
    });

    const settingsProfilesForQwen = latestSettingsSnapshot("qwen").profiles;
    assertProfileInventoryParity(
      qwen.profiles,
      settingsProfilesForQwen,
      visibleSnapshot("qwen").profiles,
    );
    assertPopoverInventoryCards(popover, settingsProfilesForQwen);
    expect(
      within(popover).queryByRole("tab", { name: "Codex" }),
    ).toBeNull();
    assertMappedUnhealthyProfilesRetainUsage(popover);
    assertUnreadableProfileNotice(popover, settings);
    const user = userEvent.setup();
    await selectAndAssertQwenProfiles(
      settings,
      settingsProfilesForQwen,
      user,
    );
    await selectCodexAndAssertSettingsOnlyProfile(settings, codex, user);

    await waitFor(() => expect(harness.providersListCalls.value).toBe(1));
  });
});
