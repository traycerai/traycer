const clientMock = vi.hoisted(
  (): { current: HostClient<HostRpcRegistry> | null } => ({ current: null }),
);
const toastFallbacks = vi.hoisted((): { readonly values: string[] } => ({
  values: [],
}));
let authServiceForTest: AuthService | null = null;

function currentAuthService(): AuthService {
  if (authServiceForTest === null) {
    throw new Error("sign-in request AuthService was not set up");
  }
  return authServiceForTest;
}

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => clientMock.current,
    useAuthService: currentAuthService,
  };
});
vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return {
    ...actual,
    useHostClient: () => clientMock.current,
    useAuthService: currentAuthService,
  };
});
vi.mock("@/hooks/host/use-host-client-for-host-id", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-client-for-host-id")
    >();
  return {
    ...actual,
    useHostClientForHostId: () => clientMock.current,
  };
});
vi.mock("@/hooks/host/use-addressable-host-id", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-addressable-host-id")
    >();
  return { ...actual, useAddressableHostId: () => "switch-computer" };
});
vi.mock(
  "@/hooks/host/use-host-directory-list-query",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/host/use-host-directory-list-query")
      >();
    return {
      ...actual,
      useHostDirectoryList: () => ({
        data: [
          {
            hostId: "switch-computer",
            label: "Switch computer",
            kind: "local",
            websocketUrl: "ws://127.0.0.1:0",
            version: "1.5.0",
            transportDialability: "dialable",
          },
        ],
      }),
    };
  },
);
vi.mock("@/lib/links/open-link", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/links/open-link")>();
  return { ...actual, useOpenLink: () => () => Promise.resolve() };
});
vi.mock("@/lib/host-error-toast", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/host-error-toast")>();
  return {
    ...actual,
    toastFromHostError: (_error: HostRpcError, fallback: string) => {
      toastFallbacks.values.push(fallback);
    },
  };
});

import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProvidersCommitProfileMoveRequest,
  ProvidersCommitProfileMoveResponse,
  ProvidersPreviewProfileMoveRequest,
  ProvidersPreviewProfileMoveResponse,
} from "@traycer/protocol/host/profile-move-schemas";
import {
  PROVIDER_PROFILE_ACCENT_COLORS,
  type ProviderLoginProfileOutcome,
  type ProviderMutationCliStateV21,
  type ProviderCliState,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  getNegotiatedHostMethods,
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useLayoutEffect, useState, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  profile,
  provider,
} from "@/components/settings/panels/permissions/__tests__/judge-test-support";
import { createProfileRecordAuthFixture } from "@/components/providers/__tests__/profile-record-auth-fixture";
import { RecordEnvironmentIdReadout } from "@/components/providers/__tests__/profile-pin-edit-dialog-test-consumers";
import { ProviderProfileAddFlowHost } from "@/components/providers/provider-profile-add-flow-host";
import { ProfileEditDialog } from "@/components/settings/panels/provider-profile-edit-dialog";
import { SwitchAccountMoveDialog } from "@/components/providers/switch-account-move-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AuthService } from "@/lib/auth/auth-service";
import { unavailableSignInRequestAuthService } from "@/lib/auth/__tests__/provider-sign-in-request-test-support";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { useProviderProfileAddFlowStore } from "@/stores/settings/provider-profile-add-flow-store";
import { ComposerDraftEditorHarness } from "@/components/chat/composer/__tests__/composer-draft-test-support";
import type { ComposerDraftSelectionRef } from "@/components/chat/composer/__tests__/composer-draft-test-support";
import { observeComposerDraft } from "@/components/chat/composer/__tests__/composer-draft-observation";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";

const HOST_ID = "switch-computer";
const SOURCE_ID = "source-profile";
const SOURCE_LABEL = "Work";
const DESTINATION_ID = "destination-profile";
const DESTINATION_LABEL = "New account";
const SUBMITTED_DESTINATION_LABEL = "Typed draft";
const SAVED_DESTINATION_LABEL = "Named account";
const BOT_ID = "bot_01HZX5Y8K3M2N4P6Q7R8S9T0V1";
const PROFILE_LIST_KEY = hostQueryKeys.method<
  HostRpcRegistry,
  "providers.list"
>(HOST_ID, "providers.list", { native: null });

type Offers = true | false | "absent";
type Entry = "manage" | "reauth";

type ListResponse = ResponseOfMethod<HostRpcRegistry, "providers.list">;
type StartRequest = RequestOfMethod<HostRpcRegistry, "providers.startLogin">;
type StartResponse = ResponseOfMethod<HostRpcRegistry, "providers.startLogin">;
type AwaitResponse = ResponseOfMethod<HostRpcRegistry, "providers.awaitLogin">;
type SetEnabledRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.setEnabled"
>;
type SetEnabledResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.setEnabled"
>;

interface SwitchHarnessInput {
  readonly offers: Offers;
  readonly entry: Entry;
  readonly before: readonly ProviderProfile[];
  readonly after: readonly ProviderProfile[];
  readonly outcome: ProviderLoginProfileOutcome | null;
  readonly preview: ProvidersPreviewProfileMoveResponse;
  readonly commitResults: ProvidersCommitProfileMoveResponse["results"];
  readonly supportedMoves: boolean;
  readonly failFirstCommit: boolean;
  readonly composer: ReactNode | null;
  readonly managedProfileInitiallyOpen: boolean;
}

interface SwitchHarness {
  readonly calls: string[];
  readonly selected: Mock<(profileId: string | null) => void>;
  readonly queryClient: QueryClient;
  readonly startRequests: StartRequest[];
  readonly setEnabledRequests: SetEnabledRequest[];
  readonly previewRequests: ProvidersPreviewProfileMoveRequest[];
  readonly commitRequests: ProvidersCommitProfileMoveRequest[];
  openManage(): void;
}

interface SwitchHarnessSceneProps {
  readonly input: SwitchHarnessInput;
  readonly selected: Mock<(profileId: string | null) => void>;
  readonly onManageReady: (openManage: (() => void) | null) => void;
}

interface MoveDialogInput {
  readonly moveHostId: string | null;
  readonly teamName: string | null;
  readonly preview: ProvidersPreviewProfileMoveResponse;
  readonly commitResults: ProvidersCommitProfileMoveResponse["results"];
  readonly supportedMoves: boolean;
  readonly failFirstPreview: boolean;
  readonly failFirstCommit: boolean;
}

interface MoveDialogHarness {
  readonly done: Mock<() => void>;
  readonly previewRequests: ProvidersPreviewProfileMoveRequest[];
  readonly commitRequests: ProvidersCommitProfileMoveRequest[];
}

afterEach(() => {
  cleanup();
  authServiceForTest?.dispose();
  authServiceForTest = null;
  vi.unstubAllGlobals();
  useProviderProfileAddFlowStore.getState().close();
  useComposerDraftStore.setState({ drafts: {} });
  clientMock.current = null;
  toastFallbacks.values.length = 0;
  resetNegotiatedManifests();
});

beforeEach(() => {
  authServiceForTest = unavailableSignInRequestAuthService();
});

function account(profileId: string, label: string): ProviderProfile {
  return {
    ...profile(profileId, "managed"),
    label,
    accentColor: profileId === SOURCE_ID ? "#f97316" : "#ef4444",
  };
}

function listBody(
  offers: Offers,
  profiles: readonly ProviderProfile[],
): ListResponse {
  const body: ListResponse = {
    providers: [provider("claude-code", [...profiles])],
    native: null,
  };
  if (offers === "absent") return body;
  return { ...body, offersSignIns: offers };
}

function startBody(profileId: string): StartResponse {
  return {
    url: "https://example.test/sign-in",
    started: true,
    profileId,
    userCode: null,
    failure: null,
    pending: null,
    pack: null,
    targetRefusal: null,
  };
}

function awaitBody(outcome: ProviderLoginProfileOutcome | null): AwaitResponse {
  return {
    state: null,
    existingProfileId: null,
    codeRejected: false,
    refusal: null,
    installation: null,
    profileOutcome: outcome,
  };
}

function legacyAwaitBody(): AwaitResponse {
  const { state } = setEnabledBody();
  return {
    ...awaitBody(null),
    state: { ...state, profiles: [account(SOURCE_ID, SOURCE_LABEL)] },
  };
}

function setEnabledBody(): SetEnabledResponse {
  const state: ProviderMutationCliStateV21 = {
    providerId: "claude-code",
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
    profiles: [],
  };
  return { state };
}

function ManagedProfileEntry(props: {
  readonly state: ProviderCliState;
  readonly profile: ProviderProfile;
  readonly profiles: readonly ProviderProfile[];
  readonly startInReauth: boolean;
  readonly onSelectedProfileIdChange: (profileId: string | null) => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  return (
    <ProfileEditDialog
      state={props.state}
      profile={props.profile}
      profiles={props.profiles}
      canOauth
      oauthUnavailableHint={null}
      startInReauth={props.startInReauth}
      isLocalHost
      open={props.open}
      onOpenChange={props.onOpenChange}
      remainingProfilesAfterRemoval={[]}
      onSelectedProfileIdChange={props.onSelectedProfileIdChange}
      profileEnablementAvailable
      profileEnablementPending={() => false}
      onSetProfileEnabled={() => undefined}
    />
  );
}

function SwitchHarnessScene(props: SwitchHarnessSceneProps): ReactNode {
  const { onManageReady } = props;
  const [managedProfileOpen, setManagedProfileOpen] = useState(
    props.input.managedProfileInitiallyOpen,
  );
  useLayoutEffect(() => {
    onManageReady(() => setManagedProfileOpen(true));
    return () => {
      onManageReady(null);
    };
  }, [onManageReady]);
  const source = props.input.before.find((row) => row.profileId === SOURCE_ID);
  if (source === undefined) throw new Error("The source profile is missing");
  return (
    <>
      {props.input.composer}
      <ManagedProfileEntry
        state={provider("claude-code", [...props.input.before])}
        profile={source}
        profiles={props.input.before}
        startInReauth={props.input.entry === "reauth"}
        onSelectedProfileIdChange={props.selected}
        open={managedProfileOpen}
        onOpenChange={setManagedProfileOpen}
      />
      <ProviderProfileAddFlowHost />
    </>
  );
}

function registerSwitchMethods(
  supportedMoves: boolean,
  recordEnvironment: boolean,
): void {
  const environmentMethods: Readonly<
    Record<string, { readonly major: number; readonly minor: number }>
  > = recordEnvironment
    ? {
        "environment.status": { major: 1, minor: 2 },
        "environment.host.read": { major: 1, minor: 1 },
      }
    : {};
  if (supportedMoves) {
    recordNegotiatedHostManifest(HOST_ID, {
      "providers.list": { major: 1, minor: 12 },
      "providers.startLogin": { major: 1, minor: 5 },
      "providers.awaitLogin": { major: 2, minor: 4 },
      "providers.previewProfileMove": { major: 1, minor: 0 },
      "providers.commitProfileMove": { major: 1, minor: 0 },
      ...environmentMethods,
    });
    return;
  }
  recordNegotiatedHostManifest(HOST_ID, {
    "providers.list": { major: 1, minor: 11 },
    "providers.startLogin": { major: 1, minor: 4 },
    ...environmentMethods,
  });
}

function renderSwitchHarness(input: SwitchHarnessInput): SwitchHarness {
  return renderSwitchHarnessWithOptions(input, false, null, false);
}

function renderSwitchHarnessForProfileRecord(
  input: SwitchHarnessInput,
  authService: AuthService,
  failFirstRecolor: boolean,
): SwitchHarness {
  return renderSwitchHarnessWithOptions(
    input,
    true,
    authService,
    failFirstRecolor,
  );
}

function renderSwitchHarnessWithOptions(
  input: SwitchHarnessInput,
  recordEnvironment: boolean,
  authService: AuthService | null,
  failFirstRecolor: boolean,
): SwitchHarness {
  const calls: string[] = [];
  const startRequests: StartRequest[] = [];
  const setEnabledRequests: SetEnabledRequest[] = [];
  const previewRequests: ProvidersPreviewProfileMoveRequest[] = [];
  const commitRequests: ProvidersCommitProfileMoveRequest[] = [];
  let awaited = false;
  let commitCount = 0;
  let recolorCount = 0;
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "providers.list": () => {
        calls.push("providers.list");
        return listBody(input.offers, awaited ? input.after : input.before);
      },
      "providers.startLogin": (params) => {
        calls.push("providers.startLogin");
        startRequests.push(params);
        return startBody(params.profileId ?? DESTINATION_ID);
      },
      "providers.awaitLogin": () => {
        calls.push("providers.awaitLogin");
        awaited = true;
        if (input.offers === "absent" && input.entry === "manage") {
          return legacyAwaitBody();
        }
        return awaitBody(input.outcome);
      },
      "providers.cancelLogin": () => {
        calls.push("providers.cancelLogin");
        return { cancelled: true };
      },
      "providers.setEnabled": (params) => {
        calls.push("providers.setEnabled");
        setEnabledRequests.push(params);
        recolorCount += 1;
        if (failFirstRecolor && recolorCount === 1) {
          throw new Error("recolor failed");
        }
        return setEnabledBody();
      },
      "providers.previewProfileMove": (params) => {
        calls.push("providers.previewProfileMove");
        previewRequests.push(params);
        return input.preview;
      },
      ...(recordEnvironment
        ? {
            "environment.status": () => {
              calls.push("environment.status");
              return environmentStatusFixture({
                principal: { kind: "personal" },
              });
            },
            "environment.host.read": () => {
              calls.push("environment.host.read");
              return {
                hostId: HOST_ID,
                environment: {
                  environmentId: "environment-profile-fixture",
                  ownerKind: "user",
                  ownerId: "test-owner",
                  roomId: "test-room",
                  label: "Personal",
                },
                explicit: false,
                enrolledByUserId: null,
                canUnbind: false,
                sharingGeneration: null,
              };
            },
          }
        : {}),
      "providers.commitProfileMove": (params) => {
        calls.push("providers.commitProfileMove");
        commitRequests.push(params);
        commitCount += 1;
        if (input.failFirstCommit && commitCount === 1) {
          throw new Error("move failed");
        }
        return {
          operationId: params.operationId,
          extent: params.extent,
          mode: params.mode,
          results: input.commitResults,
        };
      },
    },
  });
  clientMock.current = client;
  registerSwitchMethods(input.supportedMoves, recordEnvironment);
  if (authService !== null) {
    authServiceForTest?.dispose();
    authServiceForTest = authService;
  }
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(
    PROFILE_LIST_KEY,
    listBody(input.offers, input.before),
  );
  const selected = vi.fn<(profileId: string | null) => void>();
  let openManageDialog: (() => void) | null = null;
  const onManageReady = (openManage: (() => void) | null): void => {
    openManageDialog = openManage;
  };
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SwitchHarnessScene
          input={input}
          selected={selected}
          onManageReady={onManageReady}
        />
        {recordEnvironment ? (
          <RecordEnvironmentIdReadout client={client} />
        ) : null}
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return {
    calls,
    selected,
    queryClient,
    startRequests,
    setEnabledRequests,
    previewRequests,
    commitRequests,
    openManage: () => {
      if (openManageDialog === null)
        throw new Error("Manage dialog is not mounted");
      openManageDialog();
    },
  };
}

function renderMoveDialog(input: MoveDialogInput): MoveDialogHarness {
  const previewRequests: ProvidersPreviewProfileMoveRequest[] = [];
  const commitRequests: ProvidersCommitProfileMoveRequest[] = [];
  let previewCount = 0;
  let commitCount = 0;
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "providers.previewProfileMove": (params) => {
        previewRequests.push(params);
        previewCount += 1;
        if (input.failFirstPreview && previewCount === 1) {
          throw new Error("preview failed");
        }
        return input.preview;
      },
      "providers.commitProfileMove": (params) => {
        commitRequests.push(params);
        commitCount += 1;
        if (input.failFirstCommit && commitCount === 1) {
          throw new Error("move failed");
        }
        return {
          operationId: params.operationId,
          extent: params.extent,
          mode: params.mode,
          results: input.commitResults,
        };
      },
    },
  });
  clientMock.current = client;
  registerSwitchMethods(input.supportedMoves, false);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const done = vi.fn<() => void>();
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SwitchAccountMoveDialog
          providerId="claude-code"
          source={{ profileId: SOURCE_ID, label: SOURCE_LABEL }}
          destination={account(DESTINATION_ID, DESTINATION_LABEL)}
          moveHostId={input.moveHostId}
          teamName={input.teamName}
          onDone={done}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { done, previewRequests, commitRequests };
}

function emptyPreview(): ProvidersPreviewProfileMoveResponse {
  return {
    extent: "fleet",
    mode: "switch",
    targets: [],
    terminals: [],
    pendingComputers: [],
  };
}

function agentTarget(
  epicId: string,
  agentId: string,
  title: string,
  standing: "idle" | "running",
): Extract<
  ProvidersPreviewProfileMoveResponse["targets"][number],
  { kind: "agent" }
> {
  return {
    kind: "agent",
    epicId,
    agentId,
    hostId: HOST_ID,
    title,
    standing,
  };
}

function botTarget(
  botId: string,
  title: string,
): Extract<
  ProvidersPreviewProfileMoveResponse["targets"][number],
  { kind: "bot" }
> {
  return {
    kind: "bot",
    botId,
    hostId: HOST_ID,
    title,
    standing: "running",
  };
}

function agentRef(
  epicId: string,
  agentId: string,
): Extract<
  ProvidersCommitProfileMoveRequest["targets"][number],
  { kind: "agent" }
> {
  return { kind: "agent", epicId, agentId };
}

function botRef(
  botId: string,
): Extract<
  ProvidersCommitProfileMoveRequest["targets"][number],
  { kind: "bot" }
> {
  return { kind: "bot", botId };
}

async function loginIntoSwitchDialog(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
  fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
}

function successfulSwitchInput(
  preview: ProvidersPreviewProfileMoveResponse,
  commitResults: ProvidersCommitProfileMoveResponse["results"],
): SwitchHarnessInput {
  const source = account(SOURCE_ID, SOURCE_LABEL);
  const destination = account(DESTINATION_ID, DESTINATION_LABEL);
  return {
    offers: true,
    entry: "manage",
    before: [source],
    after: [source, destination],
    outcome: { kind: "signed-in", profileId: DESTINATION_ID },
    preview,
    commitResults,
    supportedMoves: true,
    failFirstCommit: false,
    composer: null,
    managedProfileInitiallyOpen: true,
  };
}

describe("Switch account moves only previewed work", () => {
  it("preserves typed composer text through the integrated switch move flow", async () => {
    const user = userEvent.setup();
    const target = agentTarget(
      "epic-composer-draft",
      "agent-composer-draft",
      "Waiting agent",
      "idle",
    );
    const preview: ProvidersPreviewProfileMoveResponse = {
      ...emptyPreview(),
      targets: [target],
    };
    const results: ProvidersCommitProfileMoveResponse["results"] = [
      {
        outcome: "moved",
        target: agentRef(target.epicId, target.agentId),
        row: target,
      },
    ];
    const chatId = target.agentId;
    const editorRef: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };
    const selectionRef: ComposerDraftSelectionRef = { current: null };
    const composer = (
      <ComposerDraftEditorHarness
        chatId={chatId}
        epicId={target.epicId}
        hostId={HOST_ID}
        editorRef={editorRef}
        selectionRef={selectionRef}
      />
    );
    const harness = renderSwitchHarness({
      ...successfulSwitchInput(preview, results),
      composer,
      managedProfileInitiallyOpen: false,
    });

    await user.type(
      await screen.findByRole("textbox", { name: "test" }),
      "unsent switch move line",
    );
    const observe = () =>
      observeComposerDraft(
        chatId,
        editorRef,
        screen.getByTestId("composer-editor"),
      );
    const before = observe();
    expect(before.editorJSON).toBe(before.draftJSON);
    expect(before.visibleText).toBe("unsent switch move line");

    act(() => harness.openManage());
    await screen.findByRole("dialog", { name: "Edit profile" });
    await loginIntoSwitchDialog();
    await screen.findByText("Move work from Work?");
    await screen.findByRole("button", { name: "Move 1" });
    const during = observe();
    expect(during).toEqual(before);

    fireEvent.click(screen.getByRole("button", { name: "Move 1" }));
    await screen.findByText("Moved 1 to New account.");
    const after = observe();
    expect(after).toEqual(before);
    expect(harness.previewRequests).toHaveLength(1);
    expect(harness.commitRequests).toHaveLength(1);
    expect(harness.commitRequests[0]?.targets).toEqual([
      agentRef(target.epicId, target.agentId),
    ]);
  });

  it("opens global Add from Manage, waits for the answer, and sends only preview refs for agents and bots", async () => {
    const idle = agentTarget("epic-idle", "agent-idle", "Idle agent", "idle");
    const running = agentTarget(
      "epic-running",
      "agent-running",
      "Running agent",
      "running",
    );
    const bot = botTarget(BOT_ID, "Running bot");
    const preview: ProvidersPreviewProfileMoveResponse = {
      extent: "fleet",
      mode: "switch",
      targets: [idle, running, bot],
      terminals: [
        {
          epicId: "epic-terminal",
          agentId: "terminal-agent",
          hostId: HOST_ID,
          title: "Terminal agent",
        },
      ],
      pendingComputers: [],
    };
    const results: ProvidersCommitProfileMoveResponse["results"] = [
      {
        outcome: "moved",
        target: agentRef(idle.epicId, idle.agentId),
        row: idle,
      },
      {
        outcome: "deferred",
        target: agentRef(running.epicId, running.agentId),
        row: running,
      },
      { outcome: "moved", target: botRef(bot.botId), row: bot },
    ];
    const harness = renderSwitchHarness(
      successfulSwitchInput(preview, results),
    );

    await loginIntoSwitchDialog();

    expect(await screen.findByText("Move work from Work?")).toBeTruthy();
    expect(
      screen.getByText(
        "3 agents and bots use Work. Move them to New account, or leave them where they are.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Idle agent")).toBeTruthy();
    expect(screen.getByText("Running agent")).toBeTruthy();
    expect(screen.getByText("Running bot")).toBeTruthy();
    expect(screen.getAllByText("Moves when its turn ends")).toHaveLength(1);
    expect(harness.previewRequests).toEqual([
      {
        extent: "fleet",
        mode: "switch",
        source: { providerId: "claude-code", profileId: SOURCE_ID },
      },
    ]);
    expect(harness.commitRequests).toHaveLength(0);
    expect(harness.calls).not.toContain("providers.setEnabled");
    expect(screen.getByRole("button", { name: "Move 3" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Move 3" }));

    expect(await screen.findByText("Moved 2 to New account.")).toBeTruthy();
    expect(screen.getByText("1 more moves when its turn ends.")).toBeTruthy();
    expect(harness.commitRequests).toHaveLength(1);
    expect(harness.commitRequests[0]?.targets).toEqual([
      { kind: "agent", epicId: "epic-idle", agentId: "agent-idle" },
      { kind: "agent", epicId: "epic-running", agentId: "agent-running" },
      { kind: "bot", botId: BOT_ID },
    ]);
    expect(harness.commitRequests[0]).toMatchObject({
      extent: "fleet",
      mode: "switch",
      source: { providerId: "claude-code", profileId: SOURCE_ID },
      destinationProfileId: DESTINATION_ID,
    });
    expect(harness.selected).toHaveBeenCalledWith(DESTINATION_ID);
  });

  it("keeps the admitted move result after the live list drops Switch account", async () => {
    const target = agentTarget("epic-idle", "agent-idle", "Idle agent", "idle");
    const preview: ProvidersPreviewProfileMoveResponse = {
      ...emptyPreview(),
      targets: [target],
    };
    const results: ProvidersCommitProfileMoveResponse["results"] = [
      {
        outcome: "moved",
        target: agentRef(target.epicId, target.agentId),
        row: target,
      },
    ];
    const harness = renderSwitchHarness(
      successfulSwitchInput(preview, results),
    );

    await loginIntoSwitchDialog();
    expect(await screen.findByRole("button", { name: "Move 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move 1" }));
    expect(await screen.findByText("Moved 1 to New account.")).toBeTruthy();

    act(() => {
      harness.queryClient.setQueryData(
        PROFILE_LIST_KEY,
        listBody(false, [account(SOURCE_ID, SOURCE_LABEL)]),
      );
    });

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Moved 1 to New account.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Link account" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Add as a new profile" }),
    ).toBeNull();
    expect(harness.startRequests).toHaveLength(1);
    expect(harness.previewRequests).toHaveLength(1);
    expect(harness.commitRequests).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps a failed commit retryable after the live provider row disappears", async () => {
    const target = agentTarget("epic-idle", "agent-idle", "Idle agent", "idle");
    const preview: ProvidersPreviewProfileMoveResponse = {
      ...emptyPreview(),
      targets: [target],
    };
    const results: ProvidersCommitProfileMoveResponse["results"] = [
      {
        outcome: "moved",
        target: agentRef(target.epicId, target.agentId),
        row: target,
      },
    ];
    const harness = renderSwitchHarness({
      ...successfulSwitchInput(preview, results),
      failFirstCommit: true,
    });

    await loginIntoSwitchDialog();
    expect(await screen.findByRole("button", { name: "Move 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move 1" }));
    await waitFor(() => expect(harness.commitRequests).toHaveLength(1));
    await waitFor(() =>
      expect(toastFallbacks.values).toContain(
        "Couldn't move the agents and bots.",
      ),
    );

    act(() => {
      harness.queryClient.setQueryData(
        PROFILE_LIST_KEY,
        listBody("absent", []),
      );
    });

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move 1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Link account" })).toBeNull();
    expect(harness.startRequests).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Move 1" }));

    expect(await screen.findByText("Moved 1 to New account.")).toBeTruthy();
    expect(harness.commitRequests).toHaveLength(2);
    expect(harness.commitRequests[1]).toEqual(harness.commitRequests[0]);
    expect(harness.startRequests).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("leaves work on the source when the person chooses none", async () => {
    const target = agentTarget("epic-idle", "agent-idle", "Idle agent", "idle");
    const preview: ProvidersPreviewProfileMoveResponse = {
      ...emptyPreview(),
      targets: [target],
    };
    const results: ProvidersCommitProfileMoveResponse["results"] = [];
    const harness = renderSwitchHarness(
      successfulSwitchInput(preview, results),
    );

    await loginIntoSwitchDialog();
    expect(
      await screen.findByRole("button", { name: "Don't move anything" }),
    ).toBeTruthy();
    expect(harness.commitRequests).toHaveLength(0);

    fireEvent.click(
      screen.getByRole("button", { name: "Don't move anything" }),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(harness.commitRequests).toHaveLength(0);
    expect(harness.selected).toHaveBeenCalledWith(DESTINATION_ID);
    expect(harness.calls).not.toContain("providers.setEnabled");
  });

  it("keeps the saved name through recolor retry into the switch move question", async () => {
    const sharedEmail = "shared-profile@example.test";
    const source = {
      ...account(SOURCE_ID, SOURCE_LABEL),
      identity: { email: sharedEmail, tier: "Pro", accountUuid: null },
      aliases: ["source-record-alias"],
    };
    const destination = {
      ...account(DESTINATION_ID, DESTINATION_LABEL),
      identity: { email: sharedEmail, tier: "Team", accountUuid: null },
      aliases: ["destination-record-alias"],
      accentColor: PROVIDER_PROFILE_ACCENT_COLORS[1],
    };
    const pickedColor = PROVIDER_PROFILE_ACCENT_COLORS[2];
    const target = agentTarget(
      "epic-named-destination",
      "agent-named-destination",
      "Destination agent",
      "idle",
    );
    const preview: ProvidersPreviewProfileMoveResponse = {
      ...emptyPreview(),
      targets: [target],
    };
    const results: ProvidersCommitProfileMoveResponse["results"] = [
      {
        outcome: "moved",
        target: agentRef(target.epicId, target.agentId),
        row: target,
      },
    ];
    const recordNameUrl = `http://localhost:5005/api/v3/environments/environment-profile-fixture/profile-records/${DESTINATION_ID}/name`;
    const auth = await createProfileRecordAuthFixture((request) => {
      if (request.url !== recordNameUrl) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            profileId: DESTINATION_ID,
            harnessId: "claude",
            recordRevision: "18",
            name: SAVED_DESTINATION_LABEL,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    });
    const harness = renderSwitchHarnessForProfileRecord(
      {
        offers: true,
        entry: "manage",
        before: [source],
        after: [source, destination],
        outcome: { kind: "signed-in", profileId: DESTINATION_ID },
        preview,
        commitResults: results,
        supportedMoves: true,
        failFirstCommit: false,
        composer: null,
        managedProfileInitiallyOpen: true,
      },
      auth.service,
      true,
    );

    await loginIntoSwitchDialog();
    expect(
      await screen.findByText(
        `${SOURCE_LABEL} already uses this email. Name this profile so you can tell them apart.`,
      ),
    ).toBeTruthy();
    expect(await screen.findByText("environment-profile-fixture")).toBeTruthy();
    const listReadsBeforeName = harness.calls.filter(
      (method) => method === "providers.list",
    ).length;
    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: SUBMITTED_DESTINATION_LABEL },
    });
    fireEvent.click(
      screen.getByRole("button", { name: `Use color ${pickedColor}` }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect(
      await screen.findByText(
        "The account was signed in, but the profile color could not be saved.",
      ),
    ).toBeTruthy();
    expect(auth.requests).toEqual([
      {
        url: recordNameUrl,
        method: "POST",
        body: JSON.stringify({
          harnessId: "claude",
          name: SUBMITTED_DESTINATION_LABEL,
        }),
      },
    ]);
    expect(
      harness.calls.filter((method) => method === "providers.list").length,
    ).toBeGreaterThan(listReadsBeforeName);
    expect(harness.setEnabledRequests).toHaveLength(1);
    expect(harness.setEnabledRequests[0]?.profileAction).toEqual({
      type: "recolor",
      profileId: DESTINATION_ID,
      accentColor: pickedColor,
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Move work from Work?")).toBeTruthy();
    expect(
      await screen.findByText(`Signed in as ${SAVED_DESTINATION_LABEL}`),
    ).toBeTruthy();
    expect(
      screen.getByText(
        `1 agents and bots use ${SOURCE_LABEL}. Move them to ${SAVED_DESTINATION_LABEL}, or leave them where they are.`,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(new RegExp(DESTINATION_LABEL))).toBeNull();
    expect(
      screen.queryByText(new RegExp(SUBMITTED_DESTINATION_LABEL)),
    ).toBeNull();
    expect(harness.previewRequests[0]).toEqual({
      extent: "fleet",
      mode: "switch",
      source: { providerId: "claude-code", profileId: SOURCE_ID },
    });
    expect(harness.setEnabledRequests).toHaveLength(2);
    expect(harness.setEnabledRequests[1]?.profileAction).toEqual({
      type: "recolor",
      profileId: DESTINATION_ID,
      accentColor: pickedColor,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Move 1" }));

    expect(
      await screen.findByText(`Moved 1 to ${SAVED_DESTINATION_LABEL}.`),
    ).toBeTruthy();
    expect(harness.commitRequests[0]?.destinationProfileId).toBe(
      DESTINATION_ID,
    );
    expect(harness.calls).not.toContain("providers.renameProfile");
    expect(harness.calls).not.toContain("providers.answerProfileName");
  });

  it("selects an existing destination record instead of creating a third row", async () => {
    const source = account(SOURCE_ID, SOURCE_LABEL);
    const destination = account(DESTINATION_ID, DESTINATION_LABEL);
    const preview: ProvidersPreviewProfileMoveResponse = {
      ...emptyPreview(),
      targets: [agentTarget("epic-idle", "agent-idle", "Idle agent", "idle")],
    };
    const harness = renderSwitchHarness({
      offers: true,
      entry: "manage",
      before: [source, destination],
      after: [source, destination],
      outcome: { kind: "already-signed-in", profileId: DESTINATION_ID },
      preview,
      commitResults: [],
      supportedMoves: true,
      failFirstCommit: false,
      composer: null,
      managedProfileInitiallyOpen: true,
    });

    await loginIntoSwitchDialog();
    expect(
      await screen.findByText(`Already signed in as ${DESTINATION_LABEL}`),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use" }));

    expect(await screen.findByText("Move work from Work?")).toBeTruthy();
    expect(harness.previewRequests[0]?.source.profileId).toBe(SOURCE_ID);
    expect(harness.commitRequests).toHaveLength(0);
    expect(harness.calls).not.toContain("providers.setEnabled");
    expect(harness.selected).toHaveBeenCalledWith(DESTINATION_ID);
  });

  it("finishes same-account sign-in with Already signed in and Done only", async () => {
    const source = account(SOURCE_ID, SOURCE_LABEL);
    const harness = renderSwitchHarness({
      offers: true,
      entry: "manage",
      before: [source],
      after: [source],
      outcome: { kind: "already-signed-in", profileId: SOURCE_ID },
      preview: emptyPreview(),
      commitResults: [],
      supportedMoves: true,
      failFirstCommit: false,
      composer: null,
      managedProfileInitiallyOpen: true,
    });

    await loginIntoSwitchDialog();

    expect(
      await screen.findByText(`Already signed in as ${SOURCE_LABEL}`),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Move work from/ })).toBeNull();
    expect(harness.previewRequests).toHaveLength(0);
    expect(harness.commitRequests).toHaveLength(0);
  });

  it("offers Switch account after Sign in again reports a different account", async () => {
    const source = account(SOURCE_ID, SOURCE_LABEL);
    const harness = renderSwitchHarness({
      offers: true,
      entry: "reauth",
      before: [source],
      after: [source],
      outcome: { kind: "account-mismatch" },
      preview: emptyPreview(),
      commitResults: [],
      supportedMoves: true,
      failFirstCommit: false,
      composer: null,
      managedProfileInitiallyOpen: true,
    });

    expect(
      await screen.findByText(
        "That sign-in is a different account. Work was not changed.",
      ),
    ).toBeTruthy();
    const reauthDialog = screen.getByRole("dialog", { name: "Sign in again" });
    fireEvent.click(
      within(reauthDialog).getByRole("button", { name: "Switch account" }),
    );

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(harness.previewRequests).toHaveLength(0);
    expect(harness.commitRequests).toHaveLength(0);
    expect(useProviderProfileAddFlowStore.getState().switchSource).toEqual({
      profileId: SOURCE_ID,
      label: SOURCE_LABEL,
    });
  });

  it("uses the preview row to name a skipped result whose commit row is null", async () => {
    const target = agentTarget(
      "epic-idle",
      "agent-idle",
      "Preview agent",
      "idle",
    );
    const preview: ProvidersPreviewProfileMoveResponse = {
      ...emptyPreview(),
      targets: [target],
    };
    const results: ProvidersCommitProfileMoveResponse["results"] = [
      {
        outcome: "skipped",
        target: agentRef(target.epicId, target.agentId),
        row: null,
        reason: "gone",
      },
    ];
    const harness = renderMoveDialog({
      moveHostId: HOST_ID,
      teamName: null,
      preview,
      commitResults: results,
      supportedMoves: true,
      failFirstPreview: false,
      failFirstCommit: false,
    });

    expect(await screen.findByRole("button", { name: "Move 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move 1" }));

    expect(
      await screen.findByRole("heading", { name: "Not moved" }),
    ).toBeTruthy();
    expect(screen.getByText("Preview agent")).toBeTruthy();
    expect(screen.getByText("No longer exists")).toBeTruthy();
    expect(harness.commitRequests).toHaveLength(1);
  });

  it("keeps the completed move result when a later manifest drops move support", async () => {
    const target = agentTarget("epic-idle", "agent-idle", "Idle agent", "idle");
    const preview: ProvidersPreviewProfileMoveResponse = {
      ...emptyPreview(),
      targets: [target],
    };
    const results: ProvidersCommitProfileMoveResponse["results"] = [
      {
        outcome: "moved",
        target: agentRef(target.epicId, target.agentId),
        row: target,
      },
    ];
    const harness = renderMoveDialog({
      moveHostId: HOST_ID,
      teamName: null,
      preview,
      commitResults: results,
      supportedMoves: true,
      failFirstPreview: false,
      failFirstCommit: false,
    });

    expect(await screen.findByRole("button", { name: "Move 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move 1" }));
    expect(await screen.findByText("Moved 1 to New account.")).toBeTruthy();

    act(() => {
      recordNegotiatedHostManifest(HOST_ID, {
        "providers.list": { major: 1, minor: 12 },
      });
    });

    expect(
      getNegotiatedHostMethods(HOST_ID)?.has("providers.previewProfileMove"),
    ).toBe(false);
    expect(screen.getByText("Moved 1 to New account.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.queryByText(/Nothing was moved\./)).toBeNull();
    expect(harness.commitRequests).toHaveLength(1);
  });

  it("retries an ordinary commit failure with the identical operation and body", async () => {
    const target = agentTarget("epic-idle", "agent-idle", "Idle agent", "idle");
    const preview: ProvidersPreviewProfileMoveResponse = {
      ...emptyPreview(),
      targets: [target],
    };
    const results: ProvidersCommitProfileMoveResponse["results"] = [
      {
        outcome: "moved",
        target: agentRef(target.epicId, target.agentId),
        row: target,
      },
    ];
    const harness = renderMoveDialog({
      moveHostId: HOST_ID,
      teamName: null,
      preview,
      commitResults: results,
      supportedMoves: true,
      failFirstPreview: false,
      failFirstCommit: true,
    });

    expect(await screen.findByRole("button", { name: "Move 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move 1" }));
    await waitFor(() => expect(harness.commitRequests).toHaveLength(1));
    await waitFor(() =>
      expect(toastFallbacks.values).toEqual([
        "Couldn't move the agents and bots.",
      ]),
    );
    expect(screen.getByRole("button", { name: "Move 1" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Move 1" }));

    expect(await screen.findByText("Moved 1 to New account.")).toBeTruthy();
    expect(harness.commitRequests).toHaveLength(2);
    expect(harness.commitRequests[1]).toEqual(harness.commitRequests[0]);
  });

  it("keeps a failed preview on Signed in as with Retry and Done", async () => {
    const harness = renderMoveDialog({
      moveHostId: HOST_ID,
      teamName: null,
      preview: emptyPreview(),
      commitResults: [],
      supportedMoves: true,
      failFirstPreview: true,
      failFirstCommit: false,
    });

    expect(
      await screen.findByText(`Signed in as ${DESTINATION_LABEL}`),
    ).toBeTruthy();
    await waitFor(() =>
      expect(toastFallbacks.values).toEqual([
        "Couldn't load the agents and bots to move.",
      ]),
    );
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(harness.previewRequests).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(harness.previewRequests).toHaveLength(2));
    expect(harness.commitRequests).toHaveLength(0);
  });

  it("does not ask about zero targets and offers Done only", async () => {
    const harness = renderMoveDialog({
      moveHostId: HOST_ID,
      teamName: null,
      preview: emptyPreview(),
      commitResults: [],
      supportedMoves: true,
      failFirstPreview: false,
      failFirstCommit: false,
    });

    expect(
      await screen.findByText(`Signed in as ${DESTINATION_LABEL}`),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Move / })).toBeNull();
    expect(screen.queryByText("Move work from Work?")).toBeNull();
    expect(harness.previewRequests).toHaveLength(1);
    expect(harness.commitRequests).toHaveLength(0);
  });

  it("does not offer a move on an older computer", async () => {
    const harness = renderMoveDialog({
      moveHostId: HOST_ID,
      teamName: null,
      preview: emptyPreview(),
      commitResults: [],
      supportedMoves: false,
      failFirstPreview: false,
      failFirstCommit: false,
    });

    expect(
      await screen.findByText(
        "Nothing was moved. Switch computer is running an older version. Update it, then open Switch account again to move agents and bots to New account.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Move / })).toBeNull();
    expect(harness.previewRequests).toHaveLength(0);
    expect(harness.commitRequests).toHaveLength(0);
  });

  it("explains a team switch with no reachable answerer without showing a zero count", async () => {
    const harness = renderMoveDialog({
      moveHostId: null,
      teamName: "Design Team",
      preview: emptyPreview(),
      commitResults: [],
      supportedMoves: true,
      failFirstPreview: false,
      failFirstCommit: false,
    });

    expect(
      await screen.findByText(
        `Nothing was moved. To move agents and bots to ${DESTINATION_LABEL}, open Switch account on one of Design Team's computers.`,
      ),
    ).toBeTruthy();
    expect(screen.getByText(`Signed in as ${DESTINATION_LABEL}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Move / })).toBeNull();
    expect(harness.previewRequests).toHaveLength(0);
    expect(harness.commitRequests).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(harness.done).toHaveBeenCalledTimes(1);
  });

  it("keeps Manage's legacy 10.11 profile-scoped sign-in when offersSignIns is absent", async () => {
    const source = account(SOURCE_ID, SOURCE_LABEL);
    const harness = renderSwitchHarness({
      offers: "absent",
      entry: "manage",
      before: [source],
      after: [source],
      outcome: null,
      preview: emptyPreview(),
      commitResults: [],
      supportedMoves: false,
      failFirstCommit: false,
      composer: null,
      managedProfileInitiallyOpen: true,
    });

    expect(
      await screen.findByText(
        "Sign in with a different account for this profile.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));

    expect(await screen.findByText("Authenticated profile")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(harness.startRequests).toHaveLength(1);
    expect(harness.startRequests[0]).toMatchObject({
      providerId: "claude-code",
      profileId: SOURCE_ID,
      createProfile: null,
      target: null,
    });
    expect(harness.calls).not.toContain("providers.setEnabled");
    expect(harness.previewRequests).toHaveLength(0);
    expect(harness.commitRequests).toHaveLength(0);
    expect(useProviderProfileAddFlowStore.getState().switchSource).toBeNull();
    expect(useProviderProfileAddFlowStore.getState().harnessId).toBeNull();
    expect(useProviderProfileAddFlowStore.getState().hostId).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(
      await screen.findByText(
        "Sign in with a different account for this profile.",
      ),
    ).toBeTruthy();
    expect(harness.selected).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  vi.doUnmock("@/lib/host");
  vi.doUnmock("@/lib/host/runtime");
  vi.doUnmock("@/hooks/host/use-host-client-for-host-id");
  vi.doUnmock("@/hooks/host/use-addressable-host-id");
  vi.doUnmock("@/hooks/host/use-host-directory-list-query");
  vi.doUnmock("@/lib/links/open-link");
  vi.doUnmock("@/lib/host-error-toast");
  vi.resetModules();
});
