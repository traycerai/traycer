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
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { HostRuntime } from "@traycer-clients/shared/host-client/host-runtime";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type {
  EnvironmentCloud,
  EnvironmentTransportAnswer,
  EnvironmentTransportRequest,
} from "@traycer-clients/shared/environment/environment-cloud";
import type { AuthnItemRow } from "@traycer-clients/shared/environment/authn-environment-schemas";
import type { EnvironmentProposalsResponse } from "@traycer/protocol/host/environment/settings-proposals";
import type { SetupScript } from "@traycer/protocol/host/environment-schemas";
import type { ConfigShellGetResponseV11 } from "@traycer/protocol/host/config/index";
import { hostRpcRegistry } from "@traycer/protocol/host";
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
import * as settingsSaveMapping from "@traycer/protocol/host/environment/settings-save-mapping";
import { useProvidersDeleteEnvOverride } from "@/hooks/providers/use-providers-delete-env-override-mutation";
import { useProvidersSetEnvOverride } from "@/hooks/providers/use-providers-set-env-override-mutation";
import { useProvidersSetPackPolicy } from "@/hooks/providers/use-providers-set-pack-policy-mutation";
import { useProvidersUsePackVersion } from "@/hooks/providers/use-providers-use-pack-version-mutation";
import { useRenameProviderProfile } from "@/hooks/providers/use-rename-provider-profile-mutation";
import { useRecolorProviderProfile } from "@/hooks/providers/use-recolor-provider-profile-mutation";
import { useRpcShellConfigController } from "@/components/settings/panels/shell/use-rpc-shell-config-controller";
import type { ShellConfigController } from "@/components/settings/panels/shell/shell-config-controller";
import { sendFollowedSave } from "@/lib/environment/settings-save-follow";
import {
  useSettingsSave,
  useSettingsItemExists,
} from "@/hooks/environment/use-settings-save";
import { SettingsSaveCoordinatorProvider } from "@/providers/settings-save-coordinator-provider";
import { HostRuntimeContext, type HostRpcRegistry } from "@/lib/host";
import { AuthService } from "@/lib/auth/auth-service";
import { createAuthBoundHostDirectory } from "@/lib/host/auth-bound-host-directory";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
  type EnvironmentClientFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { settingsSaveMemoryKey } from "@/lib/persist";
import {
  useSettingsSaveMemoryStore,
  type SettingsSaveMemoryRecord,
} from "@/stores/settings/settings-save-memory-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { ProfileEditDialog } from "@/components/settings/panels/provider-profile-edit-dialog";
import { MachineSetupSettingsPanel } from "@/components/settings/panels/machine-setup-settings-panel";
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
const addressableHostMock = vi.hoisted((): { id: string } => ({
  id: "host-a",
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => addressableHostMock.id,
}));

const ACCOUNT_A = "account-a";
const ACCOUNT_B = "account-b";
const ENVIRONMENT_ID = "environment-a";
const HOST_ID = "host-a";
const OTHER_HOST_ID = "host-b";
const SHARING_GENERATION = 4;
const PROVIDER_ID = "codex";
const ITEM_KEY = `${PROVIDER_ID}:CODEX_API_KEY`;
const ROW_ORDER_KEY = "SAVE_ORDERING_CASE";
let authIdentityGeneration = 0;
type SetEnvOverrideResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.setEnvOverride"
>;
type DeleteEnvOverrideResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.deleteEnvOverride"
>;

const MANAGED_PROFILE_KEY = `${harnessIdOfProvider("claude-code")}:p1`;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
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
  revision: number,
): AuthnItemRow {
  return itemRow(
    { kind: "env_override", key: ITEM_KEY },
    os,
    { value },
    revision,
  );
}

function itemRow(
  identity: Pick<AuthnItemRow, "kind" | "key">,
  os: AuthnItemRow["os"],
  value: AuthnItemRow["value"],
  revision: number,
): AuthnItemRow {
  return {
    ...identity,
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

function providerMutationState(
  providerId: ProviderCliState["providerId"],
): ProviderCliState {
  return {
    ...profileCliState(editableManagedProfile(false)),
    providerId,
    profiles: [],
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
    }),
  );
}

interface MutableAuthnState {
  rows: readonly AuthnItemRow[];
  rowsByKind: Readonly<Record<string, readonly AuthnItemRow[]>>;
  rowsByKindAfterApply: Readonly<
    Record<string, readonly AuthnItemRow[]>
  > | null;
  hostListed: boolean;
  failHosts: boolean;
  failItems: boolean;
  readonly itemsStarted: Deferred<void>;
  itemsGate: Deferred<EnvironmentTransportAnswer> | null;
  ownSettings: boolean;
  failSave: boolean;
  localHostId: string | null;
  readonly shellConfig: ConfigShellGetResponseV11;
  proposals: EnvironmentProposalsResponse;
  reviewAnswer: EnvironmentTransportAnswer;
  reviewPostAnswer: EnvironmentTransportAnswer;
  reviewPostGate: Deferred<EnvironmentTransportAnswer> | null;
  itemReadGates: Deferred<EnvironmentTransportAnswer>[];
  setupScripts: SetupScript[];
  originSignInChecks: number;
  itemReadResponsesReturned: number;
  revisionAfterApply: number | null;
  valueAfterApply: string | null;
}

interface SavePayload {
  readonly method: string;
  readonly request: unknown;
}

interface SaveHarness {
  readonly client: EnvironmentClientFixture["client"];
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
  readonly environmentCloud: () => EnvironmentCloud;
  readonly rotateBearerToken: () => void;
  readonly setLocalHostId: (hostId: string | null) => void;
  readonly dispose: () => void;
}

function hostListAnswer(state: MutableAuthnState): EnvironmentTransportAnswer {
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

async function itemListAnswer(
  request: EnvironmentTransportRequest,
  state: MutableAuthnState,
): Promise<EnvironmentTransportAnswer> {
  const kind = new URL(request.url).searchParams.get("kind");
  if (kind === "env_override") {
    state.itemsStarted.resolve(undefined);
    if (state.itemsGate !== null) return state.itemsGate.promise;
    if (state.failItems) return { status: 503, text: "" };
  }
  const readGate = state.itemReadGates.shift();
  if (readGate !== undefined) {
    const answer = await readGate.promise;
    state.itemReadResponsesReturned += 1;
    return answer;
  }
  const items =
    kind === "env_override" ? state.rows : (state.rowsByKind[kind ?? ""] ?? []);
  return { status: 200, text: JSON.stringify({ items }) };
}

async function reviewApplyAnswer(
  state: MutableAuthnState,
): Promise<EnvironmentTransportAnswer> {
  if (state.reviewPostGate !== null) return state.reviewPostGate.promise;
  if (state.rowsByKindAfterApply !== null) {
    state.rowsByKind = state.rowsByKindAfterApply;
    state.rowsByKindAfterApply = null;
  }
  if (state.revisionAfterApply !== null && state.valueAfterApply !== null) {
    state.rows = [
      row("macos", state.valueAfterApply, state.revisionAfterApply),
    ];
  }
  return state.reviewPostAnswer;
}

function makeSaveHarness(overrides: {
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
  readonly shellConfig?: ConfigShellGetResponseV11;
}): SaveHarness {
  const listeners = new Set<() => void>();
  const state: MutableAuthnState = {
    rows: overrides.rows ?? [row("macos", "old-value", 3)],
    rowsByKind: overrides.rowsByKind ?? {},
    rowsByKindAfterApply: null,
    hostListed: overrides.hostListed ?? true,
    failHosts: overrides.failHosts ?? false,
    failItems: overrides.failItems ?? false,
    itemsStarted: deferred<void>(),
    itemsGate: overrides.itemsGate ?? null,
    ownSettings: overrides.ownSettings ?? false,
    failSave: false,
    localHostId: overrides.localHostId ?? null,
    shellConfig: overrides.shellConfig ?? {
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
    reviewPostAnswer: { status: 200, text: "" },
    reviewPostGate: null,
    itemReadGates: [],
    setupScripts: [],
    originSignInChecks: 0,
    itemReadResponsesReturned: 0,
    revisionAfterApply: null,
    valueAfterApply: null,
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
  let bearerToken = "test-token";
  const cloud: EnvironmentCloud = {
    authnBaseUrl: "https://authn.test/",
    bearer: { kind: "cloud", getBearerToken: () => bearerToken },
    onOriginSignIn: () => true,
    transport: async (request) => {
      authnRequests.push(request);
      if (request.url.includes("/hosts?include=binding")) {
        return hostListAnswer(state);
      }
      if (request.url.includes("/items?kind=")) {
        return itemListAnswer(request, state);
      }
      if (request.url.includes("/review?include=operation")) {
        return state.reviewAnswer;
      }
      if (request.method === "POST" && request.url.includes("/review/")) {
        return reviewApplyAnswer(state);
      }
      throw new Error(`Unexpected authn route: ${request.method}`);
    },
  };
  const environmentCloud = (): EnvironmentCloud => {
    const cloudViewerId =
      useAuthStore.getState().contextMetadata?.userId ?? null;
    const cloudIdentityGeneration = authIdentityGeneration;
    return {
      ...cloud,
      onOriginSignIn: () => {
        state.originSignInChecks += 1;
        return (
          cloudViewerId !== null &&
          useAuthStore.getState().contextMetadata?.userId === cloudViewerId &&
          authIdentityGeneration === cloudIdentityGeneration
        );
      },
    };
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
      "environment.setup.get": () => {
        hostRequests.push("environment.setup.get");
        return { scripts: state.setupScripts };
      },
      "environment.setup.put": (request) => {
        captureSave("environment.setup.put", request);
        hostEvents.push("answer:environment.setup.put");
        return {
          outcome: "saved",
          revision: (request.expectedRevision ?? 0) + 1,
        };
      },
      "providers.setEnvOverride": (request) => {
        captureSave("providers.setEnvOverride", request);
        if (state.failSave) throw new Error("Test host write failed");
        hostEvents.push("answer:providers.setEnvOverride");
        return { state: providerMutationState(request.providerId) };
      },
      "providers.deleteEnvOverride": (request) => {
        captureSave("providers.deleteEnvOverride", request);
        return { state: providerMutationState(request.providerId) };
      },
      "config.shell.get": () => {
        hostRequests.push("config.shell.get");
        return state.shellConfig;
      },
      "config.shell.listDetected": () => {
        hostRequests.push("config.shell.listDetected");
        return { shells: [] };
      },
      "config.env.list": () => {
        hostRequests.push("config.env.list");
        return { entries: [] };
      },
      "config.env.set": (request) => {
        captureSave("config.env.set", request);
        hostEvents.push("answer:config.env.set");
        return { key: request.key, value: request.value };
      },
      "config.env.delete": (request) => {
        captureSave("config.env.delete", request);
        hostEvents.push("answer:config.env.delete");
        return { key: request.key, deleted: true };
      },
      "config.shell.set": (request) => {
        captureSave("config.shell.set", request);
        return { path: request.path, args: request.args };
      },
      "config.shell.add": (request) => {
        captureSave("config.shell.add", request);
        return { path: request.path, entries: [] };
      },
      "config.shell.remove": (request) => {
        captureSave("config.shell.remove", request);
        return { removed: true, path: request.path };
      },
      "config.shell.revertArgs": (request) => {
        captureSave("config.shell.revertArgs", request);
        return { path: request.path, reverted: true };
      },
      "providers.setPackPolicy": (request) => {
        captureSave("providers.setPackPolicy", request);
        return { autoDownload: request.autoDownload };
      },
      "providers.usePackVersion": (request) => {
        captureSave("providers.usePackVersion", request);
        return {
          result: { ok: true, pinnedVersion: request.version },
        };
      },
      "providers.setEnabled": (request) => {
        captureSave("providers.setEnabled", request);
        return { state: providerMutationState(request.providerId) };
      },
    },
  });
  recordNegotiatedHostManifest(HOST_ID, {
    "environment.status": { major: 1, minor: 1 },
    "environment.host.read": { major: 1, minor: 1 },
    "providers.setEnvOverride": { major: 2, minor: 2 },
    "providers.deleteEnvOverride": { major: 2, minor: 1 },
    "environment.proposals": { major: 1, minor: 0 },
    "environment.setup.get": { major: 1, minor: 0 },
    "environment.setup.put": { major: 1, minor: 0 },
    "config.shell.get": { major: 1, minor: 1 },
    "config.shell.listDetected": { major: 1, minor: 0 },
    "config.env.list": { major: 1, minor: 0 },
    "config.env.set": { major: 1, minor: 1 },
    "config.env.delete": { major: 1, minor: 0 },
    "config.shell.set": { major: 1, minor: 2 },
    "config.shell.add": { major: 1, minor: 2 },
    "config.shell.remove": { major: 1, minor: 2 },
    "config.shell.revertArgs": { major: 1, minor: 2 },
    "providers.setPackPolicy": { major: 1, minor: 1 },
    "providers.usePackVersion": { major: 1, minor: 2 },
    "providers.setEnabled": { major: 2, minor: 2 },
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 60_000 },
      mutations: { retry: false },
    },
  });
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.test/sign-in",
    authnBaseUrl: "https://authn.test",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const authService = new AuthService({ runnerHost });
  const auth = Object.assign(authService, {
    environmentCloud,
  });
  const directoryService = createAuthBoundHostDirectory({
    auth: authService,
    runnerHost,
    remoteFetcher: null,
    localHostIdSeeder: () => Promise.resolve(state.localHostId),
    onRegistryPollTick: null,
  });
  const directory = Object.assign(directoryService, {
    getLocalHostId: () => state.localHostId,
    onChange: (callback: () => void) => {
      listeners.add(callback);
      return { dispose: () => listeners.delete(callback) };
    },
  });
  let requestSequence = 0;
  const runtime = new HostRuntime<HostRpcRegistry>({
    runnerHost,
    registry: hostRpcRegistry,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "settings-save-test-" + ++requestSequence,
      handlers: {},
    }),
    requestContextProvider: authService.getRequestContextProvider(),
    directory,
    invalidator: createHostQueryInvalidator(queryClient),
    schedulingPolicy: hostRpcSchedulingPolicy,
    authorityRegistry: null,
    requestCoordinator: null,
    selectedHostId: () => state.localHostId,
    connectionRegistry: null,
    onHostTokenRenewal: () => undefined,
  });
  const binding: HostRuntimeBinding<HostRpcRegistry> = {
    runtime,
    hostClient: client,
    directory,
    auth,
    hostId: HOST_ID,
  };
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <HostRuntimeContext.Provider value={binding}>
        <SettingsSaveCoordinatorProvider>
          {props.children}
        </SettingsSaveCoordinatorProvider>
      </HostRuntimeContext.Provider>
    </QueryClientProvider>
  );
  const harness: SaveHarness = {
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
    environmentCloud,
    rotateBearerToken: () => {
      bearerToken = "rotated-test-token";
    },
    setLocalHostId: (hostId) => {
      state.localHostId = hostId;
      for (const listener of listeners) listener();
    },
    dispose: () => {
      runtime.dispose();
      directory.dispose();
      authService.dispose();
      queryClient.clear();
    },
  };
  activeHarnesses.push(harness);
  return harness;
}

interface ShellCallbacks {
  readonly onSuccess: () => void;
  readonly onError: (error: unknown) => void;
}

/** One shell command of the controller, run until its callbacks answer. */
async function runShellCommand(
  invoke: (callbacks: ShellCallbacks) => void,
): Promise<void> {
  const finished = deferred<void>();
  await act(async () => {
    invoke({
      onSuccess: () => finished.resolve(undefined),
      onError: finished.reject,
    });
    await finished.promise;
  });
}

function setRequest(value: string) {
  return {
    providerId: PROVIDER_ID,
    key: "CODEX_API_KEY",
    value,
    executableWriteGrant: null,
  } as const;
}

function proposalForEdit(proposalId: string): EnvironmentProposalsResponse {
  return {
    proposals: [
      {
        proposal: {
          proposalId,
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
}

function reviewAnswerForEdit(
  heldId: string,
  value: string,
  liveRevision: number,
  liveValue: string,
): EnvironmentTransportAnswer {
  return {
    status: 200,
    text: JSON.stringify({
      review: {
        hosts: [],
        needsYou: [
          {
            type: "held",
            heldId,
            revision: 9,
            kind: "env_override",
            key: ITEM_KEY,
            os: "macos",
            hostId: HOST_ID,
            sharingGeneration: SHARING_GENERATION,
            hostName: "Local host",
            heldAt: 2,
            live: { revision: liveRevision, value: { value: liveValue } },
            op: "put",
            value: { value },
          },
        ],
      },
    }),
  };
}

function setupProposalForEdit(
  proposalId: string,
): EnvironmentProposalsResponse {
  return {
    proposals: [
      {
        proposal: {
          proposalId,
          environmentId: ENVIRONMENT_ID,
          hostId: HOST_ID,
          sharingGeneration: SHARING_GENERATION,
          kind: "setup_script",
          key: "setup",
          os: "macos",
          operation: "put",
          state: "proposed",
        },
        localOverride: false,
        deliveredRevision: 9,
      },
    ],
  };
}

function setupReviewAnswerForEdit(
  heldId: string,
  text: string,
  liveRevision: number,
  liveText: string,
): EnvironmentTransportAnswer {
  return {
    status: 200,
    text: JSON.stringify({
      review: {
        hosts: [],
        needsYou: [
          {
            type: "held",
            heldId,
            revision: 9,
            kind: "setup_script",
            key: "setup",
            os: "macos",
            hostId: HOST_ID,
            sharingGeneration: SHARING_GENERATION,
            hostName: "Local host",
            heldAt: 2,
            live: { revision: liveRevision, value: { text: liveText } },
            op: "put",
            value: { text },
          },
        ],
      },
    }),
  };
}

function variableProposalForEdit(
  proposalId: string,
  operation: "put" | "delete",
): EnvironmentProposalsResponse {
  return {
    proposals: [
      {
        proposal: {
          proposalId,
          environmentId: ENVIRONMENT_ID,
          hostId: HOST_ID,
          sharingGeneration: SHARING_GENERATION,
          kind: "variable",
          key: ROW_ORDER_KEY,
          os: "macos",
          operation,
          state: "proposed",
        },
        localOverride: false,
        deliveredRevision: 9,
      },
    ],
  };
}

function variableReviewAnswerForEdit(options: {
  readonly heldId: string;
  readonly operation: "put" | "delete";
  readonly heldValue: string;
  readonly liveRevision: number | null;
  readonly liveValue: string | null;
}): EnvironmentTransportAnswer {
  const { heldId, operation, heldValue, liveRevision, liveValue } = options;
  const live =
    liveRevision === null
      ? null
      : { revision: liveRevision, value: { value: liveValue } };
  return {
    status: 200,
    text: JSON.stringify({
      review: {
        hosts: [],
        needsYou: [
          {
            type: "held",
            heldId,
            revision: 9,
            kind: "variable",
            key: ROW_ORDER_KEY,
            os: "macos",
            hostId: HOST_ID,
            sharingGeneration: SHARING_GENERATION,
            hostName: "Local host",
            heldAt: 2,
            live,
            op: operation,
            value: operation === "put" ? { value: heldValue } : null,
          },
        ],
      },
    }),
  };
}

type ShellSaveCallbacks = {
  readonly onSuccess: () => void;
  readonly onError: (error: unknown) => void;
};

async function invokeShellSave(
  invoke: (callbacks: ShellSaveCallbacks) => void,
): Promise<void> {
  const finished = deferred<void>();
  let saveError: unknown;
  await act(async () => {
    invoke({
      onSuccess: () => finished.resolve(undefined),
      onError: (error) => {
        saveError = error;
        finished.resolve(undefined);
      },
    });
    await finished.promise;
  });
  if (saveError !== undefined) {
    if (saveError instanceof Error) throw saveError;
    const message =
      typeof saveError === "string" ? saveError : JSON.stringify(saveError);
    throw new Error(message);
  }
}

function reviewApplyRequests(
  harness: SaveHarness,
): readonly EnvironmentTransportRequest[] {
  return harness.authnRequests.filter(
    (request) => request.method === "POST" && request.url.includes("/review/"),
  );
}

function requestBody(request: EnvironmentTransportRequest): unknown {
  return typeof request.body === "string"
    ? JSON.parse(request.body)
    : request.body;
}

async function signOutAndReenterSameAccount(): Promise<void> {
  act(() => {
    authIdentityGeneration += 1;
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });
  await waitFor(() =>
    expect(useSettingsSaveMemoryStore.persist.getOptions().name).toBe(
      settingsSaveMemoryKey(null),
    ),
  );
  act(() => {
    authIdentityGeneration += 1;
    setAccount(ACCOUNT_A);
  });
  await waitFor(() =>
    expect(useSettingsSaveMemoryStore.persist.getOptions().name).toBe(
      settingsSaveMemoryKey(ACCOUNT_A),
    ),
  );
}

async function waitForPreparedReads(
  harness: SaveHarness,
  kind: string,
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

const activeHarnesses: SaveHarness[] = [];

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
  authIdentityGeneration = 1;
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
  for (const harness of activeHarnesses.splice(0)) harness.dispose();
  addressableHostMock.id = HOST_ID;
  vi.restoreAllMocks();
  resetNegotiatedManifests();
  useSettingsSaveMemoryStore.persist.clearStorage();
  useSettingsSaveMemoryStore.setState({ records: {}, inFlight: {} });
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  window.localStorage.clear();
});

describe("settings-save callers", () => {
  it("remembers the env override before sending it on its host", async () => {
    const harness = makeSaveHarness({});
    const { result } = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness, "env_override");

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
    await waitForPreparedReads(harness, "env_override");
    harness.state.rows = [row("macos", "newer-value", 4)];

    await act(async () => {
      await result.current.mutateAsync(setRequest("person-edit"));
    });

    expect(records()[0]?.expectedLiveRevision).toBe(3);
  });

  it.each([
    {
      label: "falls back to the any row",
      rows: [row("any", "old-any", 3)],
      expectedOs: "any",
    },
    {
      label: "uses the macOS row when one exists",
      rows: [row("any", "old-any", 3), row("macos", "old-macos", 3)],
      expectedOs: "macos",
    },
  ])("$label", async ({ rows: itemRows, expectedOs }) => {
    const harness = makeSaveHarness({ rows: itemRows });
    const { result } = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness, "env_override");

    await act(async () => {
      await result.current.mutateAsync(setRequest("new-value"));
    });

    expect(records()[0]?.os).toBe(expectedOs);
  });

  it.each([
    {
      label: "the value already matches authn",
      overrides: { rows: [row("macos", "same-value", 3)] },
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
      await waitForPreparedReads(harness, "env_override");
    }

    await act(async () => {
      await result.current.mutateAsync(setRequest(value));
    });

    expect(harness.saveRequests).toEqual(["providers.setEnvOverride"]);
    expect(records()).toEqual([]);
  });

  it("sends but does not follow a save sent on a different host", async () => {
    const harness = makeSaveHarness({});
    const { result } = renderHook(
      () => useSettingsSave(harness.client, ["env_override"]),
      { wrapper: harness.wrapper },
    );
    await waitForPreparedReads(harness, "env_override");
    const sent = vi.fn(() => Promise.resolve("host-answered"));

    const pending = await result.current(
      {
        method: "providers.setEnvOverride",
        request: setRequest("new-value"),
      },
      OTHER_HOST_ID,
      harness.environmentCloud(),
    );
    const answer = await sendFollowedSave(pending, sent);

    expect(answer).toBe("host-answered");
    expect(sent).toHaveBeenCalledTimes(1);
    expect(records()).toEqual([]);
  });

  it("clears in-flight after the host answers and keeps its record", async () => {
    const harness = makeSaveHarness({});
    const { result } = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness, "env_override");

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
    const harness = makeSaveHarness({});
    harness.state.failSave = true;
    const toastError = vi.spyOn(toast, "error");
    const { result } = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness, "env_override");

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
    await waitForPreparedReads(harness, "env_override");
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
    const harness = makeSaveHarness({});
    const digest = deferred<string>();
    const digestSpy = vi
      .spyOn(environmentReview, "settingValueDigest")
      .mockReturnValue(digest.promise);
    const toastError = vi.spyOn(toast, "error");
    const { result } = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness, "env_override");
    let caught: unknown;
    let sending!: Promise<SetEnvOverrideResponse>;
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

  it("abandons a delete when the editor's account changed before preparation", async () => {
    const harness = makeSaveHarness({});
    const toastError = vi.spyOn(toast, "error");
    const { result } = renderHook(() => useProvidersDeleteEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness, "env_override");

    let deleting!: Promise<DeleteEnvOverrideResponse>;
    act(() => {
      setAccount(ACCOUNT_B);
      deleting = result.current.mutateAsync({
        providerId: PROVIDER_ID,
        key: "CODEX_API_KEY",
      });
    });
    let caught: unknown;
    await act(async () => {
      try {
        await deleting;
      } catch (error) {
        caught = error;
      }
    });
    expect(caught).toBeInstanceOf(HostRequestAbortedError);
    await waitFor(() =>
      expect(useSettingsSaveMemoryStore.persist.getOptions().name).toBe(
        settingsSaveMemoryKey(ACCOUNT_B),
      ),
    );

    expect(harness.saveRequests).toEqual([]);
    expect(records()).toEqual([]);
    expect(storedRows(ACCOUNT_A)).toEqual([]);
    expect(storedRows(ACCOUNT_B)).toEqual([]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("abandons a delete when its items read finishes after the editor account switches", async () => {
    const itemsGate = deferred<EnvironmentTransportAnswer>();
    const harness = makeSaveHarness({
      rows: [row("macos", "old-value", 3)],
      itemsGate,
    });
    const addressSpy = vi.spyOn(settingsSaveMapping, "settingsSaveBaseAddress");
    const toastError = vi.spyOn(toast, "error");
    const { result } = renderHook(() => useProvidersDeleteEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await harness.state.itemsStarted.promise;

    let deleting!: Promise<DeleteEnvOverrideResponse>;
    act(() => {
      deleting = result.current.mutateAsync({
        providerId: PROVIDER_ID,
        key: "CODEX_API_KEY",
      });
    });
    await waitFor(() => expect(addressSpy).toHaveBeenCalled());

    act(() => setAccount(ACCOUNT_B));
    await waitFor(() =>
      expect(useSettingsSaveMemoryStore.persist.getOptions().name).toBe(
        settingsSaveMemoryKey(ACCOUNT_B),
      ),
    );
    let caught: unknown;
    await act(async () => {
      itemsGate.resolve({ status: 503, text: "" });
      try {
        await deleting;
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(HostRequestAbortedError);
    expect(harness.saveRequests).toEqual([]);
    expect(records()).toEqual([]);
    expect(storedRows(ACCOUNT_A)).toEqual([]);
    expect(storedRows(ACCOUNT_B)).toEqual([]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("does not read A's applied row after the account switches to B", async () => {
    const harness = makeSaveHarness({
      rows: [row("macos", "old-value", 1)],
      localHostId: HOST_ID,
    });
    const applyAnswer = deferred<EnvironmentTransportAnswer>();
    harness.state.reviewPostGate = applyAnswer;
    harness.state.proposals = proposalForEdit(
      "00000000-0000-4000-8000-000000000053",
    );
    harness.state.reviewAnswer = reviewAnswerForEdit(
      "held-account-a-save",
      "new-value",
      1,
      "old-value",
    );
    const { result } = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness, "env_override");
    const itemReadCount = (): number =>
      harness.authnRequests.filter((request) =>
        request.url.includes("/items?kind=env_override"),
      ).length;
    let saving!: Promise<SetEnvOverrideResponse>;
    act(() => {
      saving = result.current.mutateAsync(setRequest("new-value"));
    });
    await waitFor(() => expect(reviewApplyRequests(harness)).toHaveLength(1));
    const readsBeforeSwitch = itemReadCount();
    const checksBeforeApplyAnswer = harness.state.originSignInChecks;

    act(() => setAccount(ACCOUNT_B));
    await waitFor(() =>
      expect(useSettingsSaveMemoryStore.persist.getOptions().name).toBe(
        settingsSaveMemoryKey(ACCOUNT_B),
      ),
    );
    // B's own session may start its base read during retargeting. Let that
    // read start before checking whether A's later apply starts another one.
    await waitFor(() =>
      expect(itemReadCount()).toBeGreaterThan(readsBeforeSwitch),
    );
    const readsAfterBRetarget = itemReadCount();
    harness.state.rows = [row("macos", "new-value", 2)];
    await act(async () => {
      applyAnswer.resolve({ status: 200, text: "" });
      await saving;
    });
    await waitFor(() =>
      expect(harness.state.originSignInChecks).toBeGreaterThan(
        checksBeforeApplyAnswer,
      ),
    );

    expect(itemReadCount()).toBe(readsAfterBRetarget);
    expect(records()).toEqual([]);
    expect(storedRows(ACCOUNT_A)).toHaveLength(1);
    expect(storedRows(ACCOUNT_B)).toEqual([]);
  });

  it("remembers and sends the save in the same account when no switch occurs", async () => {
    const harness = makeSaveHarness({});
    const { result } = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness, "env_override");

    await act(async () => {
      await result.current.mutateAsync(setRequest("new-value"));
    });

    expect(useSettingsSaveMemoryStore.persist.getOptions().name).toBe(
      settingsSaveMemoryKey(ACCOUNT_A),
    );
    expect(harness.saveRequests).toEqual(["providers.setEnvOverride"]);
    expect(records()).toHaveLength(1);
  });

  async function runSameAccountReentryReadCase(
    answer: EnvironmentTransportAnswer,
  ): Promise<void> {
    const itemsGate = deferred<EnvironmentTransportAnswer>();
    const harness = makeSaveHarness({ itemsGate });
    const addressSpy = vi.spyOn(settingsSaveMapping, "settingsSaveBaseAddress");
    const { result } = renderHook(() => useProvidersDeleteEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await harness.state.itemsStarted.promise;

    let deleting!: Promise<DeleteEnvOverrideResponse>;
    act(() => {
      deleting = result.current.mutateAsync({
        providerId: PROVIDER_ID,
        key: "CODEX_API_KEY",
      });
    });
    await waitFor(() => expect(addressSpy).toHaveBeenCalled());
    await signOutAndReenterSameAccount();
    await act(async () => {
      itemsGate.resolve(answer);
      await expect(deleting).rejects.toBeInstanceOf(HostRequestAbortedError);
    });
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));

    expect(harness.saveRequests).toEqual([]);
    expect(harness.recordsAtSend).toEqual([]);
    expect(records()).toEqual([]);
  }

  it("does not send a delete whose base read answers after same-account re-entry", async () => {
    await runSameAccountReentryReadCase({
      status: 200,
      text: JSON.stringify({ items: [row("macos", "old-value", 3)] }),
    });
  });

  it("does not send a delete whose base read fails after same-account re-entry", async () => {
    await runSameAccountReentryReadCase({ status: 503, text: "" });
  });

  it("sends a delete when only the token rotates during its base read", async () => {
    const itemsGate = deferred<EnvironmentTransportAnswer>();
    const harness = makeSaveHarness({ itemsGate });
    const addressSpy = vi.spyOn(settingsSaveMapping, "settingsSaveBaseAddress");
    const { result } = renderHook(() => useProvidersDeleteEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await harness.state.itemsStarted.promise;

    let deleting!: Promise<DeleteEnvOverrideResponse>;
    act(() => {
      deleting = result.current.mutateAsync({
        providerId: PROVIDER_ID,
        key: "CODEX_API_KEY",
      });
    });
    await waitFor(() => expect(addressSpy).toHaveBeenCalled());
    harness.rotateBearerToken();
    await act(async () => {
      itemsGate.resolve({
        status: 200,
        text: JSON.stringify({ items: [row("macos", "old-value", 3)] }),
      });
      await deleting;
    });

    expect(harness.saveRequests).toEqual(["providers.deleteEnvOverride"]);
    expect(harness.recordsAtSend).toHaveLength(1);
    expect(harness.recordsAtSend[0]).toMatchObject({
      kind: "env_override",
      operation: "delete",
      expectedLiveRevision: 3,
    });
  });

  it("remembers the selection from each shell mutation", async () => {
    const harness = makeSaveHarness({
      rowsByKind: {
        shell: [
          itemRow(
            { kind: "shell", key: "shell" },
            "macos",
            {
              path: "/bin/zsh",
              args: ["-l"],
            },
            3,
          ),
        ],
      },
    });
    const { result } = renderHook(
      () =>
        useRpcShellConfigController({ enabled: true, pickProgramFile: null }),
      { wrapper: harness.wrapper },
    );
    await waitFor(() => expect(result.current.config?.path).toBe("/bin/zsh"));

    await runShellCommand((callbacks) =>
      result.current.setShell({ path: "/bin/bash", args: null }, callbacks),
    );
    await runShellCommand((callbacks) =>
      result.current.addShell("/bin/fish", callbacks),
    );
    await runShellCommand((callbacks) =>
      result.current.removeShell("/bin/zsh", callbacks),
    );
    await runShellCommand((callbacks) =>
      result.current.revertShellArgs("/bin/zsh", callbacks),
    );

    const selections = harness.savePayloads.map(({ request }) => {
      if (
        typeof request !== "object" ||
        request === null ||
        !("selection" in request)
      ) {
        throw new Error("Expected shell save to state its selection");
      }
      return request.selection;
    });
    const bash = { path: "/bin/bash", args: ["-x"] };
    const fish = {
      path: "/bin/fish",
      args: [...defaultShellArgs("/bin/fish")],
    };
    const zshDefault = {
      path: "/bin/zsh",
      args: [...defaultShellArgs("/bin/zsh")],
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

  describe("a shell save that states nothing", () => {
    const entries = [{ path: "/bin/bash", args: ["-x"] }];
    const followingSystemDefault: ConfigShellGetResponseV11 = {
      path: "/bin/zsh",
      args: ["-l"],
      synthesised: true,
      entries,
    };
    const otherShellSelected: ConfigShellGetResponseV11 = {
      path: "/bin/zsh",
      args: ["-l"],
      synthesised: false,
      entries,
    };

    async function saveShell(
      shellConfig: ConfigShellGetResponseV11,
      invoke: (
        controller: ShellConfigController,
        callbacks: ShellCallbacks,
      ) => void,
    ) {
      const harness = makeSaveHarness({
        localHostId: HOST_ID,
        shellConfig,
        rowsByKind: {
          shell: [
            itemRow(
              { kind: "shell", key: "shell" },
              "macos",
              { path: "/bin/zsh", args: ["-l"] },
              3,
            ),
          ],
        },
      });
      const { result } = renderHook(
        () =>
          useRpcShellConfigController({ enabled: true, pickProgramFile: null }),
        { wrapper: harness.wrapper },
      );
      await waitFor(() =>
        expect(result.current.config?.synthesised).toBe(
          shellConfig.synthesised,
        ),
      );
      await runShellCommand((callbacks) => invoke(result.current, callbacks));
      return harness;
    }

    async function settled(harness: SaveHarness): Promise<void> {
      await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
      await waitFor(() =>
        expect(useSettingsSaveMemoryStore.getState().inFlight).toEqual({}),
      );
    }

    function expectLocalOnly(harness: SaveHarness, method: string): void {
      expect(harness.saveRequests).toEqual([method]);
      expect(harness.savePayloads[0]?.request).toMatchObject({
        selection: { kind: "not_stated" },
      });
      expect(harness.recordsAtSend).toEqual([null]);
      expect(records()).toEqual([]);
      expect(harness.hostRequests).not.toContain("environment.proposals");
    }

    it("sends new arguments for a computer that follows the system default as local only", async () => {
      const harness = await saveShell(followingSystemDefault, (c, cb) =>
        c.setShell({ path: null, args: ["-x"] }, cb),
      );
      await settled(harness);

      expectLocalOnly(harness, "config.shell.set");
      expect(harness.savePayloads[0]?.request).toMatchObject({
        path: null,
        args: ["-x"],
      });
    });

    it("states the selected shell for new arguments on a computer that has one", async () => {
      const harness = await saveShell(otherShellSelected, (c, cb) =>
        c.setShell({ path: null, args: ["-x"] }, cb),
      );

      expect(harness.savePayloads[0]?.request).toMatchObject({
        selection: { kind: "shell", path: "/bin/zsh", args: ["-x"] },
      });
      expect(harness.recordsAtSend[0]).not.toBeNull();
    });

    it.each([
      ["following the system default", followingSystemDefault, "/bin/zsh"],
      ["with another shell selected", otherShellSelected, "/bin/bash"],
    ])(
      "removes a shell that is not selected as local only on a computer %s",
      async (_label, shellConfig, path) => {
        const harness = await saveShell(shellConfig, (c, cb) =>
          c.removeShell(path, cb),
        );
        await settled(harness);

        expectLocalOnly(harness, "config.shell.remove");
      },
    );

    it.each([
      ["following the system default", followingSystemDefault, "/bin/zsh"],
      ["with another shell selected", otherShellSelected, "/bin/bash"],
    ])(
      "reverts the arguments of a shell that is not selected as local only on a computer %s",
      async (_label, shellConfig, path) => {
        const harness = await saveShell(shellConfig, (c, cb) =>
          c.revertShellArgs(path, cb),
        );
        await settled(harness);

        expectLocalOnly(harness, "config.shell.revertArgs");
      },
    );

    it("reads proposals after removing the selected shell, so the quiet cases above are not a missing read", async () => {
      const harness = await saveShell(otherShellSelected, (c, cb) =>
        c.removeShell("/bin/zsh", cb),
      );

      expect(harness.savePayloads[0]?.request).toMatchObject({
        selection: { kind: "system_default" },
      });
      expect(harness.recordsAtSend[0]).not.toBeNull();
      await waitFor(() =>
        expect(harness.hostRequests).toContain("environment.proposals"),
      );
    });
  });

  it("remembers the policy stated by pack policy callers", async () => {
    const packRow = itemRow(
      { kind: "pack_policy", key: "pack-a" },
      null,
      {
        pinnedVersion: "1.2.0",
        autoDownload: true,
      },
      3,
    );
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
          itemRow(
            { kind: "managed_profile", key: MANAGED_PROFILE_KEY },
            null,
            profileValue,
            3,
          ),
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
      harness.savePayloads.map(({ request }) => {
        if (
          typeof request !== "object" ||
          request === null ||
          !("profileAction" in request)
        ) {
          throw new Error("Expected profile save to state its action");
        }
        const { profileAction } = request;
        if (
          typeof profileAction !== "object" ||
          profileAction === null ||
          !("environmentProfileId" in profileAction)
        ) {
          throw new Error("Expected profile save action to name its profile");
        }
        const { environmentProfileId } = profileAction;
        if (
          environmentProfileId !== null &&
          typeof environmentProfileId !== "string"
        ) {
          throw new Error("Expected profile id to be a string or null");
        }
        return environmentProfileId;
      }),
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
          itemRow(
            { kind: "managed_profile", key: MANAGED_PROFILE_KEY },
            null,
            profileValue,
            3,
          ),
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
          itemRow(
            { kind: "managed_profile", key: MANAGED_PROFILE_KEY },
            null,
            profileValue,
            3,
          ),
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
    await waitForPreparedReads(harness, "env_override");
    expect(harness.hostRequests).not.toContain("environment.proposals");
    firstEditor.unmount();

    harness.state.rows = [row("macos", "advanced-live-value", 4)];
    const reopenedEditor = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness, "env_override");
    expect(harness.hostRequests).not.toContain("environment.proposals");

    await act(async () => {
      await reopenedEditor.result.current.mutateAsync(setRequest("new-value"));
    });
    const remembered = records()[0];
    expect(remembered.expectedLiveRevision).toBe(4);
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
      applyRequest === undefined ? undefined : requestBody(applyRequest);
    expect(applyBody).toMatchObject({
      revision: 9,
      expectedLiveRevision: 4,
    });
    await waitFor(() => expect(records()).toEqual([]));
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("reopens an editor at the revision written by its previous save", async () => {
    const harness = makeSaveHarness({
      rows: [row("macos", "old-value", 1)],
      localHostId: HOST_ID,
    });
    const itemReadCount = (): number =>
      harness.authnRequests.filter((request) =>
        request.url.includes("/items?kind=env_override"),
      ).length;
    const firstEditor = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness, "env_override");
    const readsAtFirstOpen = itemReadCount();
    const firstOwnRowRead = deferred<EnvironmentTransportAnswer>();
    harness.state.itemReadGates.push(firstOwnRowRead);

    harness.state.proposals = proposalForEdit(
      "00000000-0000-4000-8000-000000000031",
    );
    harness.state.reviewAnswer = reviewAnswerForEdit(
      "held-first-reopen-save",
      "first-value",
      1,
      "old-value",
    );
    harness.state.revisionAfterApply = 2;
    harness.state.valueAfterApply = "first-value";
    await act(async () => {
      await firstEditor.result.current.mutateAsync(setRequest("first-value"));
    });
    await waitFor(() => {
      expect(reviewApplyRequests(harness)).toHaveLength(1);
      expect(records()).toEqual([]);
      expect(itemReadCount()).toBeGreaterThan(readsAtFirstOpen);
    });
    firstEditor.unmount();

    const readsBeforeReopen = itemReadCount();
    harness.state.proposals = proposalForEdit(
      "00000000-0000-4000-8000-000000000032",
    );
    harness.state.reviewAnswer = reviewAnswerForEdit(
      "held-second-reopen-save",
      "second-value",
      2,
      "first-value",
    );
    harness.state.revisionAfterApply = 3;
    harness.state.valueAfterApply = "second-value";
    const reopenedEditor = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness, "env_override");
    await waitFor(() => {
      expect(itemReadCount()).toBeGreaterThan(readsBeforeReopen);
    });

    await act(async () => {
      await reopenedEditor.result.current.mutateAsync(
        setRequest("second-value"),
      );
    });
    await waitFor(() => {
      expect(reviewApplyRequests(harness)).toHaveLength(2);
      expect(records()).toEqual([]);
    });

    expect(
      harness.recordsAtSend.map((record) => record?.expectedLiveRevision),
    ).toEqual([1, 2]);
    expect(reviewApplyRequests(harness).map(requestBody)).toMatchObject([
      { revision: 9, expectedLiveRevision: 1 },
      { revision: 9, expectedLiveRevision: 2 },
    ]);
    const checksBeforeEarlierRead = harness.state.originSignInChecks;
    firstOwnRowRead.resolve({
      status: 200,
      text: JSON.stringify({
        items: [row("macos", "first-value", 2)],
      }),
    });
    await waitFor(() => {
      expect(harness.state.originSignInChecks).toBeGreaterThan(
        checksBeforeEarlierRead,
      );
    });
  });

  async function runSetupConflict(
    secondSaveWhileApplyHeld: boolean,
  ): Promise<void> {
    const initialRow = itemRow(
      { kind: "setup_script", key: "setup" },
      "macos",
      { text: "original" },
      1,
    );
    const harness = makeSaveHarness({
      rowsByKind: { setup_script: [initialRow] },
      localHostId: HOST_ID,
    });
    harness.state.setupScripts = [
      { os: "macos", text: "original", revision: 1 },
    ];
    harness.state.proposals = setupProposalForEdit(
      "00000000-0000-4000-8000-000000000041",
    );
    harness.state.reviewAnswer = setupReviewAnswerForEdit(
      "held-script-a",
      "script A",
      1,
      "original",
    );
    const applyAnswer = deferred<EnvironmentTransportAnswer>();
    harness.state.reviewPostGate = applyAnswer;
    harness.state.reviewPostAnswer = {
      status: 409,
      text: JSON.stringify({
        code: "revision_conflict",
        current: itemRow(
          { kind: "setup_script", key: "setup" },
          "macos",
          { text: "teammate" },
          2,
        ),
      }),
    };

    render(harness.wrapper({ children: <MachineSetupSettingsPanel /> }));
    await waitFor(() => {
      expect(harness.hostRequests).toContain("environment.setup.get");
      expect(
        harness.authnRequests.some((request) =>
          request.url.includes("/items?kind=setup_script"),
        ),
      ).toBe(true);
      expect(harness.queryClient.isFetching()).toBe(0);
    });

    const scriptField = screen.getByRole("textbox", {
      name: "macOS setup script",
    });
    const saveButton = screen.getByRole("button", { name: "Save" });
    fireEvent.change(scriptField, { target: { value: "script A" } });
    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(harness.saveRequests).toEqual(["environment.setup.put"]);
      expect(reviewApplyRequests(harness)).toHaveLength(1);
    });

    fireEvent.change(scriptField, { target: { value: "script B" } });
    harness.state.rowsByKind = {
      ...harness.state.rowsByKind,
      setup_script: [
        itemRow(
          { kind: "setup_script", key: "setup" },
          "macos",
          { text: "teammate" },
          2,
        ),
      ],
    };

    if (secondSaveWhileApplyHeld) {
      harness.state.proposals = setupProposalForEdit(
        "00000000-0000-4000-8000-000000000042",
      );
      harness.state.reviewAnswer = setupReviewAnswerForEdit(
        "held-script-b",
        "script B",
        2,
        "teammate",
      );
      await waitFor(() =>
        expect(saveButton.hasAttribute("disabled")).toBe(false),
      );
      fireEvent.click(saveButton);
      await waitFor(() => expect(harness.saveRequests).toHaveLength(2));
      applyAnswer.resolve(harness.state.reviewPostAnswer);
      await waitFor(() => {
        expect(reviewApplyRequests(harness)).toHaveLength(2);
      });
    } else {
      applyAnswer.resolve(harness.state.reviewPostAnswer);
      await waitFor(() => expect(records()).toEqual([]));
      harness.state.proposals = setupProposalForEdit(
        "00000000-0000-4000-8000-000000000042",
      );
      harness.state.reviewAnswer = setupReviewAnswerForEdit(
        "held-script-b",
        "script B",
        2,
        "teammate",
      );
      await waitFor(() =>
        expect(saveButton.hasAttribute("disabled")).toBe(false),
      );
      fireEvent.click(saveButton);
      await waitFor(() => {
        expect(harness.saveRequests).toHaveLength(2);
        expect(reviewApplyRequests(harness)).toHaveLength(2);
      });
    }

    await waitFor(() => expect(records()).toEqual([]));
    expect(
      harness.recordsAtSend.map((record) => record?.expectedLiveRevision),
    ).toEqual([1, 1]);
    expect(reviewApplyRequests(harness).map(requestBody)).toMatchObject([
      { expectedLiveRevision: 1 },
      { expectedLiveRevision: 1 },
    ]);
  }

  it("keeps a typed setup script on its original base when a teammate wins before apply", async () => {
    await runSetupConflict(false);
  });

  it("keeps the original base when a second script save starts while the first apply is held", async () => {
    await runSetupConflict(true);
  });

  it("moves the editor base only when a later reconcile applies its own hold", async () => {
    const harness = makeSaveHarness({ localHostId: null });
    const { result } = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness, "env_override");
    const itemReadCount = (): number =>
      harness.authnRequests.filter((request) =>
        request.url.includes("/items?kind=env_override"),
      ).length;
    const readsAtOpen = itemReadCount();

    harness.state.proposals = proposalForEdit(
      "00000000-0000-4000-8000-000000000011",
    );
    harness.state.reviewAnswer = reviewAnswerForEdit(
      "held-first-edit",
      "first-value",
      3,
      "old-value",
    );
    harness.state.revisionAfterApply = 4;
    harness.state.valueAfterApply = "first-value";
    await act(async () => {
      await result.current.mutateAsync(setRequest("first-value"));
    });
    await waitFor(() => expect(records()).toHaveLength(1));
    expect(harness.hostRequests).not.toContain("environment.proposals");
    expect(reviewApplyRequests(harness)).toHaveLength(0);
    expect(itemReadCount()).toBe(readsAtOpen);

    harness.state.proposals = proposalForEdit(
      "00000000-0000-4000-8000-000000000012",
    );
    harness.state.reviewAnswer = reviewAnswerForEdit(
      "held-first-edit-after-connect",
      "first-value",
      3,
      "old-value",
    );
    const ownRowRead = deferred<EnvironmentTransportAnswer>();
    harness.state.itemReadGates.push(ownRowRead);
    act(() => harness.setLocalHostId(HOST_ID));
    await waitFor(() => {
      expect(reviewApplyRequests(harness)).toHaveLength(1);
      expect(itemReadCount()).toBeGreaterThan(readsAtOpen);
    });
    const checksBeforeOwnRowAnswer = harness.state.originSignInChecks;
    ownRowRead.resolve({
      status: 200,
      text: JSON.stringify({ items: [row("macos", "first-value", 4)] }),
    });
    await waitFor(() =>
      expect(harness.state.originSignInChecks).toBeGreaterThan(
        checksBeforeOwnRowAnswer,
      ),
    );

    harness.state.proposals = proposalForEdit(
      "00000000-0000-4000-8000-000000000013",
    );
    harness.state.reviewAnswer = reviewAnswerForEdit(
      "held-second-edit",
      "second-value",
      4,
      "first-value",
    );
    harness.state.revisionAfterApply = 5;
    harness.state.valueAfterApply = "second-value";
    await act(async () => {
      await result.current.mutateAsync(setRequest("second-value"));
    });
    await waitFor(() => {
      expect(reviewApplyRequests(harness)).toHaveLength(2);
      expect(records()).toEqual([]);
    });

    expect(
      harness.recordsAtSend.map((record) => record?.expectedLiveRevision),
    ).toEqual([3, 4]);
    expect(reviewApplyRequests(harness).map(requestBody)).toMatchObject([
      { revision: 9, expectedLiveRevision: 3 },
      { revision: 9, expectedLiveRevision: 4 },
    ]);
  });

  it("keeps the opened base when a teammate changes the row before our own-row read", async () => {
    const harness = makeSaveHarness({
      rows: [row("macos", "old-value", 1)],
      localHostId: HOST_ID,
    });
    const { result } = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness, "env_override");
    const itemReadCount = (): number =>
      harness.authnRequests.filter((request) =>
        request.url.includes("/items?kind=env_override"),
      ).length;
    const readsAtOpen = itemReadCount();
    const ownRowRead = deferred<EnvironmentTransportAnswer>();
    harness.state.itemReadGates.push(ownRowRead);
    harness.state.proposals = proposalForEdit(
      "00000000-0000-4000-8000-000000000051",
    );
    harness.state.reviewAnswer = reviewAnswerForEdit(
      "held-own-edit-before-teammate",
      "own-value",
      1,
      "old-value",
    );
    harness.state.revisionAfterApply = 2;
    harness.state.valueAfterApply = "own-value";

    await act(async () => {
      await result.current.mutateAsync(setRequest("own-value"));
    });
    await waitFor(() => {
      expect(reviewApplyRequests(harness)).toHaveLength(1);
      expect(itemReadCount()).toBeGreaterThan(readsAtOpen);
    });

    harness.state.rows = [row("macos", "teammate-value", 3)];
    const readResponsesBeforeRelease = harness.state.itemReadResponsesReturned;
    ownRowRead.resolve({
      status: 200,
      text: JSON.stringify({
        items: [row("macos", "teammate-value", 3)],
      }),
    });
    await waitFor(() => {
      expect(harness.state.itemReadResponsesReturned).toBeGreaterThan(
        readResponsesBeforeRelease,
      );
    });

    harness.state.proposals = proposalForEdit(
      "00000000-0000-4000-8000-000000000052",
    );
    harness.state.reviewAnswer = reviewAnswerForEdit(
      "held-second-edit-after-teammate",
      "second-value",
      3,
      "teammate-value",
    );
    harness.state.reviewPostAnswer = {
      status: 409,
      text: JSON.stringify({
        code: "revision_conflict",
        current: row("macos", "teammate-value", 3),
      }),
    };
    harness.state.revisionAfterApply = null;
    harness.state.valueAfterApply = null;
    await act(async () => {
      await result.current.mutateAsync(setRequest("second-value"));
    });
    await waitFor(() => expect(reviewApplyRequests(harness)).toHaveLength(2));

    expect(
      harness.recordsAtSend.map((record) => record?.expectedLiveRevision),
    ).toEqual([1, 1]);
    expect(reviewApplyRequests(harness).map(requestBody)).toMatchObject([
      { expectedLiveRevision: 1 },
      { expectedLiveRevision: 1 },
    ]);
  });

  async function runRowOrderingCase(
    firstOperation: "put" | "delete",
    secondOperation: "put" | "delete",
    finalExpectedRevision: number | null,
  ): Promise<void> {
    const harness = makeSaveHarness({
      rowsByKind: {
        variable: [
          itemRow(
            { kind: "variable", key: ROW_ORDER_KEY },
            "macos",
            { value: "original" },
            1,
          ),
        ],
      },
      localHostId: HOST_ID,
    });
    const { result } = renderHook(
      () =>
        useRpcShellConfigController({ enabled: true, pickProgramFile: null }),
      { wrapper: harness.wrapper },
    );
    await waitForPreparedReads(harness, "variable");
    await waitFor(() =>
      expect(harness.hostRequests).toContain("config.env.list"),
    );
    const itemReadCount = (): number =>
      harness.authnRequests.filter((request) =>
        request.url.includes("/items?kind=variable"),
      ).length;
    const readsAtOpen = itemReadCount();
    const firstOwnRowRead = deferred<EnvironmentTransportAnswer>();
    const secondOwnRowRead = deferred<EnvironmentTransportAnswer>();
    harness.state.itemReadGates.push(firstOwnRowRead, secondOwnRowRead);

    const firstValue = "first-write";
    const secondValue = "second-write";
    const firstRowsAfterApply =
      firstOperation === "put"
        ? [
            itemRow(
              { kind: "variable", key: ROW_ORDER_KEY },
              "macos",
              { value: firstValue },
              2,
            ),
          ]
        : [];
    harness.state.proposals = variableProposalForEdit(
      "00000000-0000-4000-8000-000000000071",
      firstOperation,
    );
    harness.state.reviewAnswer = variableReviewAnswerForEdit({
      heldId: "held-first-row-order-write",
      operation: firstOperation,
      heldValue: firstValue,
      liveRevision: 1,
      liveValue: "original",
    });
    harness.state.rowsByKindAfterApply = { variable: firstRowsAfterApply };
    await invokeShellSave((callbacks) => {
      if (firstOperation === "put") {
        result.current.setEnv(
          { key: ROW_ORDER_KEY, value: firstValue },
          callbacks,
        );
      } else {
        result.current.deleteEnv(ROW_ORDER_KEY, callbacks);
      }
    });
    await waitFor(() => {
      expect(reviewApplyRequests(harness)).toHaveLength(1);
      expect(itemReadCount()).toBeGreaterThan(readsAtOpen);
    });

    const secondRowsAfterApply =
      secondOperation === "put"
        ? [
            itemRow(
              { kind: "variable", key: ROW_ORDER_KEY },
              "macos",
              { value: secondValue },
              3,
            ),
          ]
        : [];
    harness.state.proposals = variableProposalForEdit(
      "00000000-0000-4000-8000-000000000072",
      secondOperation,
    );
    harness.state.reviewAnswer = variableReviewAnswerForEdit({
      heldId: "held-second-row-order-write",
      operation: secondOperation,
      heldValue: secondValue,
      liveRevision: firstOperation === "put" ? 2 : null,
      liveValue: firstOperation === "put" ? firstValue : null,
    });
    harness.state.rowsByKindAfterApply = { variable: secondRowsAfterApply };
    await invokeShellSave((callbacks) => {
      if (secondOperation === "put") {
        result.current.setEnv(
          { key: ROW_ORDER_KEY, value: secondValue },
          callbacks,
        );
      } else {
        result.current.deleteEnv(ROW_ORDER_KEY, callbacks);
      }
    });
    await waitFor(() => {
      expect(reviewApplyRequests(harness)).toHaveLength(2);
      expect(itemReadCount()).toBeGreaterThan(readsAtOpen + 1);
    });

    let signInChecks = harness.state.originSignInChecks;
    secondOwnRowRead.resolve({
      status: 200,
      text: JSON.stringify({ items: secondRowsAfterApply }),
    });
    await waitFor(() => {
      expect(harness.state.originSignInChecks).toBeGreaterThan(signInChecks);
    });

    signInChecks = harness.state.originSignInChecks;
    firstOwnRowRead.resolve({
      status: 200,
      text: JSON.stringify({ items: firstRowsAfterApply }),
    });
    await waitFor(() => {
      expect(harness.state.originSignInChecks).toBeGreaterThan(signInChecks);
    });

    harness.state.proposals = { proposals: [] };
    await act(async () => {
      await result.current.setEnvAsync({
        key: ROW_ORDER_KEY,
        value: "third-write",
      });
    });
    await waitFor(() => expect(harness.saveRequests).toHaveLength(3));
    expect(harness.recordsAtSend[2]?.expectedLiveRevision).toBe(
      finalExpectedRevision,
    );
  }

  it("keeps a later put's base when an earlier delete read answers last", async () => {
    await runRowOrderingCase("delete", "put", 3);
  });

  it("keeps a later delete's base when an earlier put read answers last", async () => {
    await runRowOrderingCase("put", "delete", null);
  });

  it("does not let an older own-row read move the editor base back", async () => {
    const harness = makeSaveHarness({
      rows: [row("macos", "initial-value", 1)],
      localHostId: HOST_ID,
    });
    const { result } = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness, "env_override");
    const itemReadCount = (): number =>
      harness.authnRequests.filter((request) =>
        request.url.includes("/items?kind=env_override"),
      ).length;
    const readsAtOpen = itemReadCount();
    const earlierRead = deferred<EnvironmentTransportAnswer>();
    const laterRead = deferred<EnvironmentTransportAnswer>();
    harness.state.itemReadGates.push(earlierRead, laterRead);

    harness.state.proposals = proposalForEdit(
      "00000000-0000-4000-8000-000000000061",
    );
    harness.state.reviewAnswer = reviewAnswerForEdit(
      "held-first-own-write",
      "first-value",
      1,
      "initial-value",
    );
    harness.state.revisionAfterApply = 2;
    harness.state.valueAfterApply = "first-value";
    await act(async () => {
      await result.current.mutateAsync(setRequest("first-value"));
    });
    await waitFor(() => {
      expect(reviewApplyRequests(harness)).toHaveLength(1);
      expect(itemReadCount()).toBeGreaterThan(readsAtOpen);
    });

    harness.state.proposals = proposalForEdit(
      "00000000-0000-4000-8000-000000000062",
    );
    harness.state.reviewAnswer = reviewAnswerForEdit(
      "held-second-own-write",
      "second-value",
      2,
      "first-value",
    );
    harness.state.revisionAfterApply = 3;
    harness.state.valueAfterApply = "second-value";
    await act(async () => {
      await result.current.mutateAsync(setRequest("second-value"));
    });
    await waitFor(() => {
      expect(reviewApplyRequests(harness)).toHaveLength(2);
      expect(itemReadCount()).toBeGreaterThan(readsAtOpen + 1);
    });
    laterRead.resolve({
      status: 200,
      text: JSON.stringify({
        items: [row("macos", "second-value", 3)],
      }),
    });
    const checksBeforeLaterRead = harness.state.originSignInChecks;
    await waitFor(() => {
      expect(harness.state.originSignInChecks).toBeGreaterThan(
        checksBeforeLaterRead,
      );
    });

    const checksBeforeEarlierRead = harness.state.originSignInChecks;
    earlierRead.resolve({
      status: 200,
      text: JSON.stringify({
        items: [row("macos", "first-value", 2)],
      }),
    });
    await waitFor(() => {
      expect(harness.state.originSignInChecks).toBeGreaterThan(
        checksBeforeEarlierRead,
      );
    });

    harness.state.proposals = proposalForEdit(
      "00000000-0000-4000-8000-000000000063",
    );
    harness.state.reviewAnswer = reviewAnswerForEdit(
      "held-third-own-write",
      "third-value",
      3,
      "second-value",
    );
    harness.state.revisionAfterApply = 4;
    harness.state.valueAfterApply = "third-value";
    await act(async () => {
      await result.current.mutateAsync(setRequest("third-value"));
    });
    await waitFor(() => expect(reviewApplyRequests(harness)).toHaveLength(3));

    expect(
      harness.recordsAtSend.map((record) => record?.expectedLiveRevision),
    ).toEqual([1, 1, 3]);
    expect(reviewApplyRequests(harness).map(requestBody)).toMatchObject([
      { expectedLiveRevision: 1 },
      { expectedLiveRevision: 1 },
      { expectedLiveRevision: 3 },
    ]);
  });

  it("keeps an external change visible to a second edit in the same editor", async () => {
    const harness = makeSaveHarness({ localHostId: HOST_ID });
    const { result } = renderHook(() => useProvidersSetEnvOverride(), {
      wrapper: harness.wrapper,
    });
    await waitForPreparedReads(harness, "env_override");
    const itemReadCount = (): number =>
      harness.authnRequests.filter((request) =>
        request.url.includes("/items?kind=env_override"),
      ).length;
    const readsAtOpen = itemReadCount();

    harness.state.proposals = proposalForEdit(
      "00000000-0000-4000-8000-000000000021",
    );
    harness.state.reviewAnswer = reviewAnswerForEdit(
      "held-own-edit",
      "own-value",
      3,
      "old-value",
    );
    harness.state.revisionAfterApply = 4;
    harness.state.valueAfterApply = "own-value";
    await act(async () => {
      await result.current.mutateAsync(setRequest("own-value"));
    });
    await waitFor(() => {
      expect(reviewApplyRequests(harness)).toHaveLength(1);
      expect(records()).toEqual([]);
      expect(itemReadCount()).toBeGreaterThan(readsAtOpen);
    });

    harness.state.rows = [row("macos", "other-device-value", 5)];
    harness.state.proposals = proposalForEdit(
      "00000000-0000-4000-8000-000000000022",
    );
    harness.state.reviewAnswer = reviewAnswerForEdit(
      "held-second-edit",
      "second-value",
      5,
      "other-device-value",
    );
    harness.state.reviewPostAnswer = {
      status: 409,
      text: JSON.stringify({
        code: "revision_conflict",
        current: row("macos", "other-device-value", 5),
      }),
    };
    harness.state.revisionAfterApply = null;
    harness.state.valueAfterApply = null;
    await act(async () => {
      await result.current.mutateAsync(setRequest("second-value"));
    });
    await waitFor(() => {
      expect(reviewApplyRequests(harness)).toHaveLength(2);
      expect(records()).toEqual([]);
    });

    expect(
      harness.recordsAtSend.map((record) => record?.expectedLiveRevision),
    ).toEqual([3, 4]);
    const secondApplyRequest = reviewApplyRequests(harness).at(1);
    expect(secondApplyRequest).toBeDefined();
    expect(
      secondApplyRequest === undefined
        ? undefined
        : requestBody(secondApplyRequest),
    ).toMatchObject({
      revision: 9,
      expectedLiveRevision: 4,
    });
  });
});
