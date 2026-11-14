const clientMock = vi.hoisted(
  (): { current: HostClient<HostRpcRegistry> | null } => ({ current: null }),
);
const toastFallbacks = vi.hoisted((): { readonly values: string[] } => ({
  values: [],
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => clientMock.current };
});
vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return { ...actual, useHostClient: () => clientMock.current };
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
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProvidersCommitProfileMoveRequest,
  ProvidersCommitProfileMoveResponse,
  ProvidersPreviewProfileMoveRequest,
  ProvidersPreviewProfileMoveResponse,
} from "@traycer/protocol/host/profile-move-schemas";
import type {
  ProviderLoginProfileOutcome,
  ProviderMutationCliStateV21,
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  getNegotiatedHostMethods,
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
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
import { ProviderProfileAddFlowHost } from "@/components/providers/provider-profile-add-flow-host";
import { ProfileEditDialog } from "@/components/settings/panels/provider-profile-edit-dialog";
import { SwitchAccountMoveDialog } from "@/components/providers/switch-account-move-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { useProviderProfileAddFlowStore } from "@/stores/settings/provider-profile-add-flow-store";

const HOST_ID = "switch-computer";
const SOURCE_ID = "source-profile";
const SOURCE_LABEL = "Work";
const DESTINATION_ID = "destination-profile";
const DESTINATION_LABEL = "New account";
const BOT_ID = "bot_01HZX5Y8K3M2N4P6Q7R8S9T0V1";
const PROFILE_LIST_KEY = hostQueryKeys.method<
  HostRpcRegistry,
  "providers.list"
>(HOST_ID, "providers.list", { native: null });

type Offers = true | false | "absent";
type Entry = "manage" | "reauth";

type ListResponse = ResponseOfMethod<HostRpcRegistry, "providers.list">;
type StartResponse = ResponseOfMethod<HostRpcRegistry, "providers.startLogin">;
type AwaitResponse = ResponseOfMethod<HostRpcRegistry, "providers.awaitLogin">;
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
}

interface SwitchHarness {
  readonly calls: string[];
  readonly selected: Mock<(profileId: string | null) => void>;
  readonly previewRequests: ProvidersPreviewProfileMoveRequest[];
  readonly commitRequests: ProvidersCommitProfileMoveRequest[];
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
  useProviderProfileAddFlowStore.getState().close();
  clientMock.current = null;
  toastFallbacks.values.length = 0;
  resetNegotiatedManifests();
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
}): ReactNode {
  const [open, setOpen] = useState(true);
  return (
    <ProfileEditDialog
      state={props.state}
      profile={props.profile}
      profiles={props.profiles}
      canOauth
      oauthUnavailableHint={null}
      startInReauth={props.startInReauth}
      isLocalHost
      open={open}
      onOpenChange={setOpen}
      remainingProfilesAfterRemoval={[]}
      onSelectedProfileIdChange={props.onSelectedProfileIdChange}
      profileEnablementAvailable
      profileEnablementPending={() => false}
      onSetProfileEnabled={() => undefined}
    />
  );
}

function registerSwitchMethods(supportedMoves: boolean): void {
  if (supportedMoves) {
    recordNegotiatedHostManifest(HOST_ID, {
      "providers.list": { major: 1, minor: 12 },
      "providers.startLogin": { major: 1, minor: 5 },
      "providers.awaitLogin": { major: 2, minor: 4 },
      "providers.previewProfileMove": { major: 1, minor: 0 },
      "providers.commitProfileMove": { major: 1, minor: 0 },
    });
    return;
  }
  recordNegotiatedHostManifest(HOST_ID, {
    "providers.list": { major: 1, minor: 11 },
    "providers.startLogin": { major: 1, minor: 4 },
  });
}

function renderSwitchHarness(input: SwitchHarnessInput): SwitchHarness {
  const calls: string[] = [];
  const previewRequests: ProvidersPreviewProfileMoveRequest[] = [];
  const commitRequests: ProvidersCommitProfileMoveRequest[] = [];
  let awaited = false;
  let commitCount = 0;
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "providers.list": () => {
        calls.push("providers.list");
        return listBody(input.offers, awaited ? input.after : input.before);
      },
      "providers.startLogin": () => {
        calls.push("providers.startLogin");
        return startBody(input.entry === "reauth" ? SOURCE_ID : DESTINATION_ID);
      },
      "providers.awaitLogin": () => {
        calls.push("providers.awaitLogin");
        awaited = true;
        return awaitBody(input.outcome);
      },
      "providers.cancelLogin": () => {
        calls.push("providers.cancelLogin");
        return { cancelled: true };
      },
      "providers.setEnabled": () => {
        calls.push("providers.setEnabled");
        return setEnabledBody();
      },
      "providers.previewProfileMove": (params) => {
        calls.push("providers.previewProfileMove");
        previewRequests.push(params);
        return input.preview;
      },
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
  registerSwitchMethods(input.supportedMoves);
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
  const source = input.before.find((row) => row.profileId === SOURCE_ID);
  if (source === undefined) throw new Error("The source profile is missing");
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ManagedProfileEntry
          state={provider("claude-code", [...input.before])}
          profile={source}
          profiles={input.before}
          startInReauth={input.entry === "reauth"}
          onSelectedProfileIdChange={selected}
        />
        <ProviderProfileAddFlowHost />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { calls, selected, previewRequests, commitRequests };
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
  registerSwitchMethods(input.supportedMoves);
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
  };
}

describe("Switch account moves only previewed work", () => {
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

  it("keeps Manage's legacy 10.11 account-change screen when offersSignIns is absent", async () => {
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
    });

    expect(
      await screen.findByText(
        "Sign in with a different account for this profile.",
      ),
    ).toBeTruthy();
    expect(harness.previewRequests).toHaveLength(0);
    expect(harness.commitRequests).toHaveLength(0);
    expect(useProviderProfileAddFlowStore.getState().switchSource).toBeNull();
    expect(useProviderProfileAddFlowStore.getState().harnessId).toBeNull();
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
