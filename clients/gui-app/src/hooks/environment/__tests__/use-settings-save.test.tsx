import "../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { HostRequestAbortedError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  EnvironmentCloud,
  EnvironmentTransportAnswer,
  EnvironmentTransportRequest,
} from "@traycer-clients/shared/environment/environment-cloud";
import type { AuthnItemRow } from "@traycer-clients/shared/environment/authn-environment-schemas";
import type { EnvironmentProposalsResponse } from "@traycer/protocol/host/environment/settings-proposals";
import type { ConfigShellGetResponseV11 } from "@traycer/protocol/host/config/index";
import { defaultShellArgs } from "@traycer/protocol/config/shell-family";
import { harnessIdOfProvider } from "@traycer/protocol/host/environment/item-identity";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentHostReadResponseV11 } from "@traycer/protocol/host/environment/contracts";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import { settingValueDigest } from "@traycer-clients/shared/environment/environment-review";
import * as environmentReview from "@traycer-clients/shared/environment/environment-review";
import { useProvidersDeleteEnvOverride } from "@/hooks/providers/use-providers-delete-env-override-mutation";
import { useProvidersSetEnvOverride } from "@/hooks/providers/use-providers-set-env-override-mutation";
import { useProvidersSetPackPolicy } from "@/hooks/providers/use-providers-set-pack-policy-mutation";
import { useProvidersUsePackVersion } from "@/hooks/providers/use-providers-use-pack-version-mutation";
import { useRenameProviderProfile } from "@/hooks/providers/use-rename-provider-profile-mutation";
import { useRecolorProviderProfile } from "@/hooks/providers/use-recolor-provider-profile-mutation";
import { useRpcShellConfigController } from "@/components/settings/panels/shell/use-rpc-shell-config-controller";
import {
  sendFollowedSave,
  useSettingsSave,
  useSettingsItemExists,
} from "@/hooks/environment/use-settings-save";
import { SettingsSaveCoordinatorProvider } from "@/providers/settings-save-coordinator-provider";
import { HostRuntimeContext, type HostRpcRegistry } from "@/lib/host";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { settingsSaveMemoryKey } from "@/lib/persist";
import {
  useSettingsSaveMemoryStore,
  type SettingsSaveMemoryRecord,
} from "@/stores/settings/settings-save-memory-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { ProfileEditDialog } from "@/components/settings/panels/provider-profile-edit-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/hooks/providers/use-remove-provider-profile-mutation", () => ({
  useRemoveProviderProfile: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-sign-out-provider-profile-mutation", () => ({
  useSignOutProviderProfile: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-set-provider-profile-api-key-mutation", () => ({
  useSetProviderProfileApiKey: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
vi.mock(
  "@/hooks/providers/use-clear-provider-profile-api-key-mutation",
  () => ({
    useClearProviderProfileApiKey: () => ({
      mutate: vi.fn(),
      isPending: false,
      error: null,
    }),
  }),
);
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => null,
}));

const ACCOUNT_A = "account-a";
const ACCOUNT_B = "account-b";
const ENVIRONMENT_ID = "environment-a";
const HOST_ID = "host-a";
const OTHER_HOST_ID = "host-b";
const SHARING_GENERATION = 4;
const PROVIDER_ID = "codex";
const ITEM_KEY = `${PROVIDER_ID}:CODEX_API_KEY`;
const MANAGED_PROFILE_KEY = `${harnessIdOfProvider("claude-code")}:p1`;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setAccount(userId: string): void {
  useAuthStore.setState({
    ...useAuthStore.getInitialState(),
    status: "signed-in",
    profile: { userId, userName: userId, email: `${userId}@example.test` },
    contextMetadata: { userId, username: userId },
  });
}

function row(
  os: AuthnItemRow["os"],
  value: string,
  revision = 3,
): AuthnItemRow {
  return itemRow("env_override", ITEM_KEY, os, { value }, revision);
}

function itemRow(
  kind: string,
  key: string,
  os: AuthnItemRow["os"],
  value: AuthnItemRow["value"],
  revision = 3,
): AuthnItemRow {
  return {
    kind,
    key,
    os,
    value,
    revision,
    updatedAt: 1,
    writtenBy: { source: "user", hostId: null, hostName: null },
  };
}

function editableManagedProfile(enabled: boolean): ProviderProfile {
  return {
    profileId: "p1",
    enabled,
    kind: "managed",
    authType: "oauth",
    label: "Before",
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: { email: null, tier: null, accountUuid: null },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
    environmentProfileId: "p1",
  };
}

function profileCliState(profile: ProviderProfile): ProviderCliState {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
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
    profiles: [profile],
  };
}

function renderManagedProfileDialog(
  harness: SaveHarness,
  profile: ProviderProfile,
): void {
  render(
    harness.wrapper({
      children: (
        <TooltipProvider>
          <ProfileEditDialog
            state={profileCliState(profile)}
            profile={profile}
            profiles={[profile]}
            canOauth
            oauthUnavailableHint={null}
            startInReauth={false}
            isLocalHost
            open
            onOpenChange={() => undefined}
            remainingProfilesAfterRemoval={[]}
            onSelectedProfileIdChange={() => undefined}
            profileEnablementAvailable
            profileEnablementPending={() => false}
            onSetProfileEnabled={() => undefined}
          />
        </TooltipProvider>
      ),
    }) as ReactNode,
  );
}

interface MutableAuthnState {
  rows: readonly AuthnItemRow[];
  readonly rowsByKind: Readonly<Record<string, readonly AuthnItemRow[]>>;
  hostListed: boolean;
  failHosts: boolean;
  failItems: boolean;
  readonly itemsStarted: Deferred<void>;
  itemsGate: Deferred<EnvironmentTransportAnswer> | null;
  ownSettings: boolean;
  failSave: boolean;
  localHostId: string | null;
  readonly shellConfig: ConfigShellGetResponseV11;
  readonly proposals: EnvironmentProposalsResponse;
  readonly reviewAnswer: EnvironmentTransportAnswer;
}

interface SavePayload {
  readonly method: string;
  readonly request: unknown;
}

interface SaveHarness {
  readonly client: ReturnType<typeof buildEnvironmentClient>["client"];
  readonly queryClient: QueryClient;
  readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly state: MutableAuthnState;
  readonly authnRequests: EnvironmentTransportRequest[];
  readonly hostRequests: string[];
  readonly hostEvents: string[];
  readonly saveRequests: string[];
  readonly savePayloads: SavePayload[];
  readonly recordsAtSend: (SettingsSaveMemoryRecord | null)[];
  readonly cloud: EnvironmentCloud;
  readonly setLocalHostId: (hostId: string | null) => void;
}

function makeSaveHarness(
  overrides: {
    readonly rows?: readonly AuthnItemRow[];
    readonly hostListed?: boolean;
    readonly failHosts?: boolean;
    readonly failItems?: boolean;
    readonly itemsGate?: Deferred<EnvironmentTransportAnswer> | null;
    readonly ownSettings?: boolean;
    readonly rowsByKind?: Readonly<Record<string, readonly AuthnItemRow[]>>;
    readonly localHostId?: string | null;
    readonly proposals?: EnvironmentProposalsResponse;
    readonly reviewAnswer?: EnvironmentTransportAnswer;
  } = {},
): SaveHarness {
  const listeners = new Set<() => void>();
  const state: MutableAuthnState = {
    rows: overrides.rows ?? [row("macos", "old-value")],
    rowsByKind: overrides.rowsByKind ?? {},
    hostListed: overrides.hostListed ?? true,
    failHosts: overrides.failHosts ?? false,
    failItems: overrides.failItems ?? false,
    itemsStarted: deferred<void>(),
    itemsGate: overrides.itemsGate ?? null,
    ownSettings: overrides.ownSettings ?? false,
    failSave: false,
    localHostId: overrides.localHostId ?? null,
    shellConfig: {
      path: "/bin/zsh",
      args: ["-l"],
      synthesised: false,
      entries: [{ path: "/bin/bash", args: ["-x"] }],
    },
    proposals: overrides.proposals ?? { proposals: [] },
    reviewAnswer: overrides.reviewAnswer ?? {
      status: 200,
      text: JSON.stringify({ review: { hosts: [], needsYou: [] } }),
    },
  };
  const authnRequests: EnvironmentTransportRequest[] = [];
  const hostRequests: string[] = [];
  const hostEvents: string[] = [];
  const saveRequests: string[] = [];
  const savePayloads: SavePayload[] = [];
  const recordsAtSend: (SettingsSaveMemoryRecord | null)[] = [];
  const captureSave = (method: string, request: unknown): void => {
    hostRequests.push(method);
    hostEvents.push(`request:${method}`);
    saveRequests.push(method);
    savePayloads.push({ method, request });
    recordsAtSend.push(
      Object.values(useSettingsSaveMemoryStore.getState().records)[0] ?? null,
    );
  };
  const cloud: EnvironmentCloud = {
    authnBaseUrl: "https://authn.test/",
    bearer: { getBearerToken: () => "test-token" },
    onOriginSignIn: () => true,
    transport: async (request) => {
      authnRequests.push(request);
      if (request.url.includes("/hosts?include=binding")) {
        if (state.failHosts) return { status: 503, text: "" };
        return {
          status: 200,
          text: JSON.stringify({
            hosts: state.hostListed
              ? [
                  {
                    hostId: HOST_ID,
                    sharingGeneration: SHARING_GENERATION,
                    hostPlatform: "darwin-arm64",
                  },
                ]
              : [],
          }),
        };
      }
      if (request.url.includes("/items?kind=")) {
        const kind = new URL(request.url).searchParams.get("kind");
        if (kind === "env_override") {
          state.itemsStarted.resolve(undefined);
          if (state.itemsGate !== null) return state.itemsGate.promise;
          if (state.failItems) return { status: 503, text: "" };
        }
        const items =
          kind === "env_override"
            ? state.rows
            : (state.rowsByKind[kind ?? ""] ?? []);
        return { status: 200, text: JSON.stringify({ items }) };
      }
      if (request.url.includes("/review?include=operation")) {
        return state.reviewAnswer;
      }
      if (request.method === "POST" && request.url.includes("/review/")) {
        return { status: 200, text: "" };
      }
      throw new Error(`Unexpected authn route: ${request.method}`);
    },
  };

  const hostBinding: EnvironmentHostReadResponseV11 = {
    hostId: HOST_ID,
    environment: {
      environmentId: ENVIRONMENT_ID,
      ownerKind: "user",
      ownerId: ACCOUNT_A,
      roomId: "room-a",
      label: "Personal",
    },
    explicit: false,
    enrolledByUserId: null,
    canUnbind: false,
    sharingGeneration: SHARING_GENERATION,
  };
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "environment.status": () => {
        hostRequests.push("environment.status");
        return environmentStatusFixture({
          principal: state.ownSettings ? null : { kind: "personal" },
        });
      },
      "environment.host.read": () => {
        hostRequests.push("environment.host.read");
        return hostBinding;
      },
      "environment.proposals": () => {
        hostRequests.push("environment.proposals");
        hostEvents.push("read:environment.proposals");
        return state.proposals;
      },
      "providers.setEnvOverride": (request) => {
        captureSave("providers.setEnvOverride", request);
        if (state.failSave) throw new Error("Test host write failed");
        hostEvents.push("answer:providers.setEnvOverride");
        return { state: {} as never };
      },
      "providers.deleteEnvOverride": (request) => {
        captureSave("providers.deleteEnvOverride", request);
        return { state: {} as never };
      },
      "config.shell.get": () => {
        hostRequests.push("config.shell.get");
        return state.shellConfig;
      },
      "config.shell.listDetected": () => {
        hostRequests.push("config.shell.listDetected");
        return { shells: [] } as never;
      },
      "config.env.list": () => {
        hostRequests.push("config.env.list");
        return { entries: [] } as never;
      },
      "config.shell.set": (request) => {
        captureSave("config.shell.set", request);
        return {} as never;
      },
      "config.shell.add": (request) => {
        captureSave("config.shell.add", request);
        return {} as never;
      },
      "config.shell.remove": (request) => {
        captureSave("config.shell.remove", request);
        return {} as never;
      },
      "config.shell.revertArgs": (request) => {
        captureSave("config.shell.revertArgs", request);
        return {} as never;
      },
      "providers.setPackPolicy": (request) => {
        captureSave("providers.setPackPolicy", request);
        return { autoDownload: request.autoDownload };
      },
      "providers.usePackVersion": (request) => {
        captureSave("providers.usePackVersion", request);
        return {
          result: { ok: true, pinnedVersion: request.version },
        } as never;
      },
      "providers.setEnabled": (request) => {
        captureSave("providers.setEnabled", request);
        return {} as never;
      },
    },
  });
  recordNegotiatedHostManifest(HOST_ID, {
    "environment.status": { major: 1, minor: 1 },
    "environment.host.read": { major: 1, minor: 1 },
    "providers.setEnvOverride": { major: 2, minor: 2 },
    "providers.deleteEnvOverride": { major: 2, minor: 1 },
    "environment.proposals": { major: 1, minor: 0 },
    "config.shell.get": { major: 1, minor: 1 },
    "config.shell.listDetected": { major: 1, minor: 0 },
    "config.env.list": { major: 1, minor: 0 },
    "config.shell.set": { major: 1, minor: 2 },
    "config.shell.add": { major: 1, minor: 2 },
    "config.shell.remove": { major: 1, minor: 2 },
    "config.shell.revertArgs": { major: 1, minor: 2 },
    "providers.setPackPolicy": { major: 1, minor: 1 },
    "providers.usePackVersion": { major: 1, minor: 2 },
    "providers.setEnabled": { major: 2, minor: 2 },
  });
  const auth = { environmentCloud: () => cloud };
  const directory = {
    getLocalHostId: () => state.localHostId,
    onChange: (callback: () => void) => {
      listeners.add(callback);
      return { dispose: () => listeners.delete(callback) };
    },
  };
  const binding = {
    runtime: null,
    hostClient: client,
    directory,
    auth,
    hostId: HOST_ID,
  } as unknown as HostRuntimeBinding<HostRpcRegistry>;
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <HostRuntimeContext.Provider value={binding}>
        <SettingsSaveCoordinatorProvider>
          {props.children}
        </SettingsSaveCoordinatorProvider>
      </HostRuntimeContext.Provider>
    </QueryClientProvider>
  );
  return {
    client,
    queryClient,
    wrapper,
    state,
    authnRequests,
    hostRequests,
    hostEvents,
    saveRequests,
    savePayloads,
    recordsAtSend,
    cloud,
    setLocalHostId: (hostId) => {
      state.localHostId = hostId;
      for (const listener of listeners) listener();
    },
  };
}

function setRequest(value: string) {
  return {
    providerId: PROVIDER_ID,
    key: "CODEX_API_KEY",
    value,
    executableWriteGrant: null,
  } as const;
}

async function waitForPreparedReads(
  harness: SaveHarness,
  kind = "env_override",
): Promise<void> {
  await waitFor(() => {
    expect(harness.hostRequests).toContain("environment.status");
    expect(harness.hostRequests).toContain("environment.host.read");
    expect(
      harness.authnRequests.some((request) =>
        request.url.includes("/hosts?include=binding"),
      ),
    ).toBe(true);
    expect(
      harness.authnRequests.some((request) =>
        request.url.includes(`/items?kind=${kind}`),
      ),
    ).toBe(true);
    expect(harness.queryClient.isFetching()).toBe(0);
  });
}

function records(): readonly SettingsSaveMemoryRecord[] {
  return Object.values(useSettingsSaveMemoryStore.getState().records);
}

function storedRows(accountId: string): readonly string[] {
  const prefix = `${settingsSaveMemoryKey(accountId)}:records:`;
  const rows: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key === null || !key.startsWith(prefix)) continue;
    const value = window.localStorage.getItem(key);
    if (value !== null && value !== "null") rows.push(value);
  }
  return rows;
}

beforeEach(() => {
  window.localStorage.clear();
  useSettingsSaveMemoryStore.persist.setOptions({
    name: settingsSaveMemoryKey(null),
  });
  useSettingsSaveMemoryStore.persist.clearStorage();
  useSettingsSaveMemoryStore.setState({ records: {}, inFlight: {} });
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  setAccount(ACCOUNT_A);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetNegotiatedManifests();
  useSettingsSaveMemoryStore.persist.clearStorage();
  useSettingsSaveMemoryStore.setState({ records: {}, inFlight: {} });
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  window.localStorage.clear();
});

describe("settings-save callers", () => {
  it("remembers the env override before sending it on its host", async () => {
    const harness = makeSaveHarness();
    const { result } = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness);

    await act(async () => {
      await result.current.mutateAsync(setRequest("new-value"));
    });

    const remembered = harness.recordsAtSend[0];
    expect(remembered).toMatchObject({
      kind: "env_override",
      key: ITEM_KEY,
      os: "macos",
      operation: "put",
      expectedLiveRevision: 3,
    });
    expect(remembered?.valueDigest).toBe(
      await settingValueDigest({ value: "new-value" }),
    );
  });

  it("keeps the revision read when the editor opened", async () => {
    const harness = makeSaveHarness({ rows: [row("macos", "old-value", 3)] });
    const { result } = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness);
    harness.state.rows = [row("macos", "newer-value", 4)];

    await act(async () => {
      await result.current.mutateAsync(setRequest("person-edit"));
    });

    expect(records()[0]?.expectedLiveRevision).toBe(3);
  });

  it.each([
    {
      label: "falls back to the any row",
      rows: [row("any", "old-any")],
      expectedOs: "any",
    },
    {
      label: "uses the macOS row when one exists",
      rows: [row("any", "old-any"), row("macos", "old-macos")],
      expectedOs: "macos",
    },
  ])("$label", async ({ rows: itemRows, expectedOs }) => {
    const harness = makeSaveHarness({ rows: itemRows });
    const { result } = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness);

    await act(async () => {
      await result.current.mutateAsync(setRequest("new-value"));
    });

    expect(records()[0]?.os).toBe(expectedOs);
  });

  it.each([
    {
      label: "the value already matches authn",
      overrides: { rows: [row("macos", "same-value")] },
      value: "same-value",
    },
    {
      label: "authn does not list the host",
      overrides: { hostListed: false },
      value: "new-value",
    },
    {
      label: "authn's host read fails",
      overrides: { failHosts: true },
      value: "new-value",
    },
    {
      label: "the host reports own settings",
      overrides: { ownSettings: true },
      value: "new-value",
    },
  ])("still sends when $label", async ({ overrides, value }) => {
    const harness = makeSaveHarness(overrides);
    const { result } = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    if ("ownSettings" in overrides && overrides.ownSettings) {
      await waitFor(() =>
        expect(harness.hostRequests).toContain("environment.status"),
      );
    } else {
      await waitForPreparedReads(harness);
    }

    await act(async () => {
      await result.current.mutateAsync(setRequest(value));
    });

    expect(harness.saveRequests).toEqual(["providers.setEnvOverride"]);
    expect(records()).toEqual([]);
  });

  it("sends but does not follow a save sent on a different host", async () => {
    const harness = makeSaveHarness();
    const { result } = renderHook(
      () => useSettingsSave(harness.client, ["env_override"]),
      { wrapper: harness.wrapper },
    );
    await waitForPreparedReads(harness);
    const sent = vi.fn(async () => "host-answered");

    const pending = await result.current(
      {
        method: "providers.setEnvOverride",
        request: setRequest("new-value"),
      },
      OTHER_HOST_ID,
    );
    const answer = await sendFollowedSave(pending, sent);

    expect(answer).toBe("host-answered");
    expect(sent).toHaveBeenCalledTimes(1);
    expect(records()).toEqual([]);
  });

  it("clears in-flight after the host answers and keeps its record", async () => {
    const harness = makeSaveHarness();
    const { result } = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness);

    await act(async () => {
      await result.current.mutateAsync(setRequest("new-value"));
    });
    await waitFor(() =>
      expect(useSettingsSaveMemoryStore.getState().inFlight).toEqual({}),
    );

    expect(harness.saveRequests).toHaveLength(1);
    expect(records()).toHaveLength(1);
  });

  it("clears in-flight on a failed save, reports the error, and toasts it", async () => {
    const harness = makeSaveHarness();
    harness.state.failSave = true;
    const toastError = vi.spyOn(toast, "error");
    const { result } = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness);

    await act(async () => {
      await expect(
        result.current.mutateAsync(setRequest("new-value")),
      ).rejects.toBeDefined();
    });
    await waitFor(() =>
      expect(useSettingsSaveMemoryStore.getState().inFlight).toEqual({}),
    );

    expect(harness.saveRequests).toHaveLength(1);
    expect(records()).toHaveLength(1);
    expect(toastError).toHaveBeenCalled();
  });

  it("reads proposals after an answered save through the production mount", async () => {
    const harness = makeSaveHarness({ localHostId: HOST_ID });
    const { result } = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness);
    const readsBeforeSave = harness.hostEvents.filter(
      (event) => event === "read:environment.proposals",
    ).length;
    expect(harness.hostEvents).not.toContain("answer:providers.setEnvOverride");

    await act(async () => {
      await result.current.mutateAsync(setRequest("new-value"));
    });
    await waitFor(() =>
      expect(
        harness.hostEvents.filter(
          (event) => event === "read:environment.proposals",
        ).length,
      ).toBeGreaterThan(readsBeforeSave),
    );

    const answerIndex = harness.hostEvents.indexOf(
      "answer:providers.setEnvOverride",
    );
    const proposalsReadIndex = harness.hostEvents.indexOf(
      "read:environment.proposals",
      answerIndex + 1,
    );
    expect(answerIndex).toBeGreaterThan(-1);
    expect(proposalsReadIndex).toBeGreaterThan(answerIndex);
    expect(
      harness.authnRequests.some((request) => request.method === "POST"),
    ).toBe(false);
  });

  it("aborts silently if the account switches while a put is hashed", async () => {
    const harness = makeSaveHarness();
    const digest = deferred<string>();
    const digestSpy = vi
      .spyOn(environmentReview, "settingValueDigest")
      .mockReturnValue(digest.promise);
    const toastError = vi.spyOn(toast, "error");
    const { result } = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness);
    let caught: unknown;
    let sending!: ReturnType<typeof result.current.mutateAsync>;
    act(() => {
      sending = result.current.mutateAsync(setRequest("new-value"));
    });
    await waitFor(() => expect(digestSpy).toHaveBeenCalled());

    act(() => setAccount(ACCOUNT_B));
    await waitFor(() =>
      expect(useSettingsSaveMemoryStore.persist.getOptions().name).toBe(
        settingsSaveMemoryKey(ACCOUNT_B),
      ),
    );
    await act(async () => {
      digest.resolve("held-digest");
      try {
        await sending;
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(HostRequestAbortedError);
    expect(harness.saveRequests).toEqual([]);
    expect(records()).toEqual([]);
    expect(storedRows(ACCOUNT_A)).toEqual([]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("does not send a delete whose items read finishes after an account switch", async () => {
    const itemsGate = deferred<EnvironmentTransportAnswer>();
    const harness = makeSaveHarness({
      rows: [row("macos", "old-value")],
      itemsGate,
    });
    const { result } = renderHook(() => useProvidersDeleteEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await harness.state.itemsStarted.promise;
    let deleting!: ReturnType<typeof result.current.mutateAsync>;
    act(() => {
      deleting = result.current.mutateAsync({
        providerId: PROVIDER_ID,
        key: "CODEX_API_KEY",
      });
    });

    act(() => setAccount(ACCOUNT_B));
    await waitFor(() =>
      expect(useSettingsSaveMemoryStore.persist.getOptions().name).toBe(
        settingsSaveMemoryKey(ACCOUNT_B),
      ),
    );
    await act(async () => {
      itemsGate.resolve({
        status: 200,
        text: JSON.stringify({ items: [row("macos", "old-value")] }),
      });
      await deleting;
    });

    expect(harness.saveRequests).toEqual([]);
    expect(records()).toEqual([]);
    expect(storedRows(ACCOUNT_A)).toEqual([]);
  });

  it("does not send a save when an items read fails after an account switch", async () => {
    const itemsGate = deferred<EnvironmentTransportAnswer>();
    const harness = makeSaveHarness({
      rows: [row("macos", "old-value")],
      itemsGate,
    });
    const { result } = renderHook(() => useProvidersDeleteEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await harness.state.itemsStarted.promise;
    let deleting!: ReturnType<typeof result.current.mutateAsync>;
    act(() => {
      deleting = result.current.mutateAsync({
        providerId: PROVIDER_ID,
        key: "CODEX_API_KEY",
      });
    });

    act(() => setAccount(ACCOUNT_B));
    await waitFor(() =>
      expect(useSettingsSaveMemoryStore.persist.getOptions().name).toBe(
        settingsSaveMemoryKey(ACCOUNT_B),
      ),
    );
    await act(async () => {
      itemsGate.resolve({ status: 503, text: "" });
      await deleting;
    });

    expect(harness.saveRequests).toEqual([]);
    expect(records()).toEqual([]);
    expect(storedRows(ACCOUNT_A)).toEqual([]);
  });

  it("remembers and sends the save in the same account when no switch occurs", async () => {
    const harness = makeSaveHarness();
    const { result } = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness);

    await act(async () => {
      await result.current.mutateAsync(setRequest("new-value"));
    });

    expect(useSettingsSaveMemoryStore.persist.getOptions().name).toBe(
      settingsSaveMemoryKey(ACCOUNT_A),
    );
    expect(harness.saveRequests).toEqual(["providers.setEnvOverride"]);
    expect(records()).toHaveLength(1);
  });

  it("remembers the selection from each shell mutation", async () => {
    const harness = makeSaveHarness({
      rowsByKind: {
        shell: [
          itemRow("shell", "shell", "macos", {
            path: "/bin/zsh",
            args: ["-l"],
          }),
        ],
      },
    });
    const { result } = renderHook(
      () =>
        useRpcShellConfigController({ enabled: true, pickProgramFile: null }),
      { wrapper: harness.wrapper },
    );
    await waitFor(() => expect(result.current.config?.path).toBe("/bin/zsh"));

    const run = async (
      invoke: (callbacks: {
        readonly onSuccess: () => void;
        readonly onError: (error: unknown) => void;
      }) => void,
    ) => {
      const finished = deferred<void>();
      await act(async () => {
        invoke({
          onSuccess: () => finished.resolve(undefined),
          onError: finished.reject,
        });
        await finished.promise;
      });
    };

    await run((callbacks) =>
      result.current.setShell({ path: "/bin/bash", args: null }, callbacks),
    );
    await run((callbacks) => result.current.addShell("/bin/fish", callbacks));
    await run((callbacks) => result.current.removeShell("/bin/zsh", callbacks));
    await run((callbacks) =>
      result.current.revertShellArgs("/bin/zsh", callbacks),
    );

    const selections = harness.savePayloads.map(
      ({ request }) => (request as { readonly selection: unknown }).selection,
    );
    const bash = { path: "/bin/bash", args: ["-x"] };
    const fish = {
      path: "/bin/fish",
      args: defaultShellArgs("/bin/fish"),
    };
    const zshDefault = {
      path: "/bin/zsh",
      args: defaultShellArgs("/bin/zsh"),
    };
    expect(harness.saveRequests).toEqual([
      "config.shell.set",
      "config.shell.add",
      "config.shell.remove",
      "config.shell.revertArgs",
    ]);
    expect(selections).toEqual([
      { kind: "shell", ...bash },
      { kind: "shell", ...fish },
      { kind: "system_default" },
      { kind: "shell", ...zshDefault },
    ]);
    expect(harness.recordsAtSend).toHaveLength(4);
    expect(harness.recordsAtSend[0]).toMatchObject({
      kind: "shell",
      key: "shell",
      os: "macos",
      operation: "put",
      valueDigest: await settingValueDigest(bash),
    });
    expect(harness.recordsAtSend[1]?.valueDigest).toBe(
      await settingValueDigest(fish),
    );
    expect(harness.recordsAtSend[2]).toMatchObject({
      kind: "shell",
      key: "shell",
      os: "macos",
      operation: "delete",
      valueDigest: null,
    });
    expect(harness.recordsAtSend[3]?.valueDigest).toBe(
      await settingValueDigest(zshDefault),
    );
  });

  it("remembers the policy stated by pack policy callers", async () => {
    const packRow = itemRow("pack_policy", "pack-a", null, {
      pinnedVersion: "1.2.0",
      autoDownload: true,
    });
    const harness = makeSaveHarness({
      rowsByKind: { pack_policy: [packRow] },
    });
    const { result } = renderHook(
      () => ({
        setPolicy: useProvidersSetPackPolicy(),
        useVersion: useProvidersUsePackVersion(null),
      }),
      { wrapper: harness.wrapper },
    );
    await waitForPreparedReads(harness, "pack_policy");

    await act(async () => {
      await result.current.setPolicy.mutateAsync({
        packId: "pack-a",
        autoDownload: false,
        policy: { pinnedVersion: "1.2.0", autoDownload: false },
      });
    });
    await act(async () => {
      await result.current.useVersion.mutateAsync({
        packId: "pack-a",
        version: "1.3.0",
        policy: { pinnedVersion: "1.3.0", autoDownload: true },
      });
    });
    await act(async () => {
      await result.current.useVersion.mutateAsync({
        packId: "pack-a",
        version: null,
        policy: { pinnedVersion: null, autoDownload: true },
      });
    });

    const policies = [
      { pinnedVersion: "1.2.0", autoDownload: false },
      { pinnedVersion: "1.3.0", autoDownload: true },
      { pinnedVersion: null, autoDownload: true },
    ] as const;
    expect(harness.saveRequests).toEqual([
      "providers.setPackPolicy",
      "providers.usePackVersion",
      "providers.usePackVersion",
    ]);
    expect(harness.recordsAtSend).toHaveLength(3);
    for (const [index, policy] of policies.entries()) {
      expect(harness.recordsAtSend[index]).toMatchObject({
        kind: "pack_policy",
        key: "pack-a",
        os: null,
        operation: "put",
        valueDigest: await settingValueDigest(policy),
      });
    }
  });

  it("remembers the managed profile after rename and recolor", async () => {
    const profileValue = {
      id: "p1",
      name: "Before",
      color: "#10b981",
      enabled: true,
    };
    const harness = makeSaveHarness({
      rowsByKind: {
        managed_profile: [
          itemRow("managed_profile", MANAGED_PROFILE_KEY, null, profileValue),
        ],
      },
    });
    const { result } = renderHook(
      () => ({
        rename: useRenameProviderProfile(),
        recolor: useRecolorProviderProfile(),
        itemExists: useSettingsItemExists(harness.client, "managed_profile"),
      }),
      { wrapper: harness.wrapper },
    );
    await waitForPreparedReads(harness, "managed_profile");
    await expect(result.current.itemExists(MANAGED_PROFILE_KEY)).resolves.toBe(
      true,
    );
    await act(async () => {
      await result.current.rename.mutateAsync({
        providerId: "claude-code",
        profileId: "p1",
        label: "After",
        enabled: true,
        environmentProfileId: "p1",
      });
    });
    await act(async () => {
      await result.current.recolor.mutateAsync({
        providerId: "claude-code",
        profileId: "p1",
        accentColor: "#f97316",
        enabled: true,
        environmentProfileId: "p1",
      });
    });

    expect(harness.saveRequests).toEqual([
      "providers.setEnabled",
      "providers.setEnabled",
    ]);
    expect(
      harness.savePayloads.map(
        ({ request }) =>
          (
            request as {
              readonly profileAction: {
                readonly environmentProfileId: string | null;
              };
            }
          ).profileAction.environmentProfileId,
      ),
    ).toEqual(["p1", "p1"]);
    expect(harness.recordsAtSend[0]).toMatchObject({
      kind: "managed_profile",
      key: MANAGED_PROFILE_KEY,
      os: null,
      operation: "put",
      valueDigest: await settingValueDigest({ ...profileValue, name: "After" }),
    });
    expect(harness.recordsAtSend[1]?.valueDigest).toBe(
      await settingValueDigest({ ...profileValue, color: "#f97316" }),
    );
  });

  it("keeps a disabled profile disabled through dialog rename and recolor", async () => {
    const profileValue = {
      id: "p1",
      name: "Before",
      color: null,
      enabled: false,
    };
    const profile = editableManagedProfile(false);
    const harness = makeSaveHarness({
      rowsByKind: {
        managed_profile: [
          itemRow("managed_profile", MANAGED_PROFILE_KEY, null, profileValue),
        ],
      },
    });
    renderManagedProfileDialog(harness, profile);
    await waitForPreparedReads(harness, "managed_profile");

    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "After" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(harness.saveRequests).toHaveLength(1));

    expect(harness.savePayloads[0]?.request).toMatchObject({
      enabled: false,
    });
    expect(harness.recordsAtSend[0]).toMatchObject({
      kind: "managed_profile",
      key: MANAGED_PROFILE_KEY,
      valueDigest: await settingValueDigest({ ...profileValue, name: "After" }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Use color #f97316" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(harness.saveRequests).toHaveLength(2));

    expect(harness.savePayloads[1]?.request).toMatchObject({
      enabled: false,
    });
    expect(harness.recordsAtSend[1]?.valueDigest).toBe(
      await settingValueDigest({ ...profileValue, color: "#f97316" }),
    );
  });

  it("keeps an enabled profile enabled through dialog rename", async () => {
    const profileValue = {
      id: "p1",
      name: "Before",
      color: null,
      enabled: true,
    };
    const profile = editableManagedProfile(true);
    const harness = makeSaveHarness({
      rowsByKind: {
        managed_profile: [
          itemRow("managed_profile", MANAGED_PROFILE_KEY, null, profileValue),
        ],
      },
    });
    renderManagedProfileDialog(harness, profile);
    await waitForPreparedReads(harness, "managed_profile");

    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "After" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(harness.saveRequests).toHaveLength(1));

    expect(harness.savePayloads[0]?.request).toMatchObject({
      enabled: true,
    });
  });

  it("applies a proposal on connect using the revision from the reopened editor", async () => {
    const proposal: EnvironmentProposalsResponse = {
      proposals: [
        {
          proposal: {
            proposalId: "00000000-0000-4000-8000-000000000001",
            environmentId: ENVIRONMENT_ID,
            hostId: HOST_ID,
            sharingGeneration: SHARING_GENERATION,
            kind: "env_override",
            key: ITEM_KEY,
            os: "macos",
            operation: "put",
            state: "proposed",
          },
          localOverride: false,
          deliveredRevision: 3,
        },
      ],
    };
    const reviewAnswer: EnvironmentTransportAnswer = {
      status: 200,
      text: JSON.stringify({
        review: {
          hosts: [],
          needsYou: [
            {
              type: "held",
              heldId: "held-new-value",
              revision: 9,
              kind: "env_override",
              key: ITEM_KEY,
              os: "macos",
              hostId: HOST_ID,
              sharingGeneration: SHARING_GENERATION,
              hostName: "Local host",
              heldAt: 2,
              live: { revision: 4, value: { value: "advanced-live-value" } },
              op: "put",
              value: { value: "new-value" },
            },
          ],
        },
      }),
    };
    const harness = makeSaveHarness({
      rows: [row("macos", "old-value", 3)],
      localHostId: null,
      proposals: proposal,
      reviewAnswer,
    });
    const toastError = vi.spyOn(toast, "error");
    const toastSuccess = vi.spyOn(toast, "success");
    const firstEditor = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness);
    expect(harness.hostRequests).not.toContain("environment.proposals");
    firstEditor.unmount();

    harness.state.rows = [row("macos", "advanced-live-value", 4)];
    harness.queryClient.clear();
    const reopenedEditor = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness);
    expect(harness.hostRequests).not.toContain("environment.proposals");

    await act(async () => {
      await reopenedEditor.result.current.mutateAsync(setRequest("new-value"));
    });
    const remembered = records()[0];
    expect(remembered?.expectedLiveRevision).toBe(4);
    expect(harness.hostRequests).not.toContain("environment.proposals");

    act(() => harness.setLocalHostId(HOST_ID));
    await waitFor(() => {
      expect(harness.hostRequests).toContain("environment.proposals");
      expect(
        harness.authnRequests.some(
          (request) =>
            request.method === "POST" && request.url.includes("/review/"),
        ),
      ).toBe(true);
    });
    const saveIndex = harness.hostRequests.indexOf("providers.setEnvOverride");
    const proposalsIndex = harness.hostRequests.indexOf(
      "environment.proposals",
    );
    expect(proposalsIndex).toBeGreaterThan(saveIndex);
    const applyRequest = harness.authnRequests.find(
      (request) =>
        request.method === "POST" && request.url.includes("/review/"),
    );
    const applyBody =
      typeof applyRequest?.body === "string"
        ? JSON.parse(applyRequest.body)
        : applyRequest?.body;
    expect(applyBody).toMatchObject({
      revision: 9,
      expectedLiveRevision: 4,
    });
    await waitFor(() => expect(records()).toEqual([]));
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
