import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  HostMethodVersionUnsatisfiedError,
  HostRpcError,
  HostTransportFailureError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  ProvidersCommitProfileMoveRequest,
  ProvidersCommitProfileMoveResponse,
  ProvidersPreviewProfileMoveRequest,
  ProvidersPreviewProfileMoveResponse,
} from "@traycer/protocol/host/profile-move-schemas";
import {
  providersCommitProfileMoveRequestSchema,
  providersCommitProfileMoveResponseSchema,
  providersPreviewProfileMoveRequestSchema,
  providersPreviewProfileMoveResponseSchema,
} from "@traycer/protocol/host/profile-move-schemas";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { MOVE_ERROR_FALLBACKS } from "../profile-move-copy";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostQueryKeys } from "@/lib/query-keys";
import { ProfileMoveDialog } from "../profile-move-dialog";
import { ComposerDraftEditorHarness } from "@/components/chat/composer/__tests__/composer-draft-test-support";
import type { ComposerDraftSelectionRef } from "@/components/chat/composer/__tests__/composer-draft-test-support";
import { observeComposerDraft } from "@/components/chat/composer/__tests__/composer-draft-observation";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";

const sonnerErrors = vi.hoisted(() => ({
  error: vi.fn<(message: ReactNode) => string>(() => "toast-id"),
}));

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return {
    ...actual,
    toast: Object.assign(vi.fn(), actual.toast, { error: sonnerErrors.error }),
  };
});

vi.mock("@/hooks/providers/use-profile-move-computer-names", () => ({
  useProfileMoveComputerNames:
    () =>
    (hostId: string | null): string =>
      hostId === null ? "" : `Computer ${hostId}`,
}));

const HOST_ID = mockLocalHostEntry.hostId;
const REMOTE_HOST = mockRemoteHostEntry.hostId;
const THIRD_HOST = "third-host";
const OLDER_COMPUTER_NOTICE = `Computer ${HOST_ID} is running an older version. Update it to move its agents.`;
const SOURCE: ProvidersPreviewProfileMoveRequest["source"] =
  providersPreviewProfileMoveRequestSchema.parse({
    extent: "fleet",
    mode: "waiting",
    source: { providerId: "claude-code", profileId: "source-profile" },
  }).source;
type PreviewTarget = ProvidersPreviewProfileMoveResponse["targets"][number];
const AGENT_ROW: Extract<PreviewTarget, { readonly kind: "agent" }> = {
  kind: "agent",
  epicId: "epic-a",
  agentId: "agent-a",
  hostId: HOST_ID,
  title: "Waiting agent",
  standing: "waiting",
};
const BOT_ROW: Extract<PreviewTarget, { readonly kind: "bot" }> = {
  kind: "bot",
  botId: "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  hostId: HOST_ID,
  title: "Waiting bot",
  standing: "waiting",
};
const TERMINAL: ProvidersPreviewProfileMoveResponse["terminals"][number] = {
  epicId: "epic-a",
  agentId: "terminal-agent",
  hostId: HOST_ID,
  title: "Terminal agent",
};
const PREVIEW: ProvidersPreviewProfileMoveResponse =
  providersPreviewProfileMoveResponseSchema.parse({
    extent: "fleet",
    mode: "waiting",
    targets: [AGENT_ROW, BOT_ROW],
    terminals: [TERMINAL],
    pendingComputers: [],
  });
const EMPTY_PREVIEW: ProvidersPreviewProfileMoveResponse =
  providersPreviewProfileMoveResponseSchema.parse({
    extent: "fleet",
    mode: "waiting",
    targets: [],
    terminals: [],
    pendingComputers: [],
  });

function providerProfile(profileId: string, label: string): ProviderProfile {
  return {
    profileId,
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

const PROFILES = [
  providerProfile("source-profile", "Source profile"),
  providerProfile("destination-profile", "Destination profile"),
];

interface MoveDialogHarness {
  readonly client: HostClient<HostRpcRegistry>;
  readonly requests: ProvidersCommitProfileMoveRequest[];
  readonly previewCalls: Array<
    RequestOfMethod<HostRpcRegistry, "providers.previewProfileMove">
  >;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly hosts: Map<string, HostDirectoryEntry>;
}

function createHarness(input: {
  readonly preview: (
    request: RequestOfMethod<HostRpcRegistry, "providers.previewProfileMove">,
    callIndex: number,
  ) =>
    | ResponseOfMethod<HostRpcRegistry, "providers.previewProfileMove">
    | Promise<
        ResponseOfMethod<HostRpcRegistry, "providers.previewProfileMove">
      >;
  readonly commit: (
    request: ProvidersCommitProfileMoveRequest,
  ) =>
    | ResponseOfMethod<HostRpcRegistry, "providers.commitProfileMove">
    | Promise<ResponseOfMethod<HostRpcRegistry, "providers.commitProfileMove">>;
}): MoveDialogHarness {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const requests: ProvidersCommitProfileMoveRequest[] = [];
  const previewCalls: Array<
    RequestOfMethod<HostRpcRegistry, "providers.previewProfileMove">
  > = [];
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "move-dialog-request",
    handlers: {
      "providers.previewProfileMove": (
        params: RequestOfMethod<
          HostRpcRegistry,
          "providers.previewProfileMove"
        >,
      ):
        | ResponseOfMethod<HostRpcRegistry, "providers.previewProfileMove">
        | Promise<
            ResponseOfMethod<HostRpcRegistry, "providers.previewProfileMove">
          > => {
        const request = providersPreviewProfileMoveRequestSchema.parse(params);
        previewCalls.push(request);
        return Promise.resolve(
          input.preview(request, previewCalls.length - 1),
        ).then((response) =>
          providersPreviewProfileMoveResponseSchema.parse(response),
        );
      },
      "providers.commitProfileMove": (
        params: ProvidersCommitProfileMoveRequest,
      ):
        | ProvidersCommitProfileMoveResponse
        | Promise<ProvidersCommitProfileMoveResponse> => {
        const request = providersCommitProfileMoveRequestSchema.parse(params);
        requests.push(request);
        return Promise.resolve(input.commit(request)).then((response) =>
          providersCommitProfileMoveResponseSchema.parse(response),
        );
      },
    },
  });
  const hosts = new Map<string, HostDirectoryEntry>([
    [HOST_ID, mockLocalHostEntry],
    [REMOTE_HOST, mockRemoteHostEntry],
    [THIRD_HOST, { ...mockRemoteHostEntry, hostId: THIRD_HOST }],
  ]);
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) => hosts.get(hostId) ?? null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-move",
    }),
  );
  const client = spine.createRequester(mockLocalHostEntry);

  function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  }

  return {
    client,
    requests,
    previewCalls,
    Wrapper,
    messenger,
    queryClient,
    hosts,
  };
}

function skippedBotResult(
  request: ProvidersCommitProfileMoveRequest,
): ProvidersCommitProfileMoveResponse {
  return providersCommitProfileMoveResponseSchema.parse({
    operationId: request.operationId,
    extent: request.extent,
    mode: request.mode,
    results: [
      {
        outcome: "moved",
        target: {
          kind: "agent",
          epicId: AGENT_ROW.epicId,
          agentId: AGENT_ROW.agentId,
        },
        row: AGENT_ROW,
      },
      {
        outcome: "skipped",
        target: { kind: "bot", botId: BOT_ROW.botId },
        row: null,
        reason: "gone",
      },
    ],
  });
}

function dialogElement(
  harness: MoveDialogHarness,
  onClose: () => void,
): ReactNode {
  return (
    <ProfileMoveDialog
      client={harness.client}
      source={SOURCE}
      sourceLabel="Source profile"
      profiles={PROFILES}
      onClose={onClose}
      onRestartTerminal={vi.fn()}
    />
  );
}

function renderDialog(harness: MoveDialogHarness) {
  return render(dialogElement(harness, vi.fn()), { wrapper: harness.Wrapper });
}

function moveFloorFailure(
  method: "providers.previewProfileMove" | "providers.commitProfileMove",
): HostMethodVersionUnsatisfiedError {
  return new HostMethodVersionUnsatisfiedError({
    requirement: { method, version: { major: 1, minor: 0 } },
    negotiated: undefined,
    requestId: "move-dialog-request",
    method,
    hostId: HOST_ID,
  });
}

afterEach(() => {
  cleanup();
  useComposerDraftStore.setState({ drafts: {} });
  sonnerErrors.error.mockClear();
});

afterAll(() => {
  vi.doUnmock("@/hooks/providers/use-profile-move-computer-names");
  vi.doUnmock("sonner");
});

describe("ProfileMoveDialog", () => {
  it("commits 70 targets directly on their owning computers, with the bot once on the anchor", async () => {
    const user = userEvent.setup();
    const targets: PreviewTarget[] = [
      ...Array.from({ length: 67 }, (_value, index) => ({
        ...AGENT_ROW,
        agentId: `local-${index}`,
      })),
      { ...BOT_ROW, hostId: null },
      { ...AGENT_ROW, agentId: "remote-one", hostId: REMOTE_HOST },
      { ...AGENT_ROW, agentId: "remote-two", hostId: THIRD_HOST },
    ];
    const harness = createHarness({
      preview: () => ({ ...PREVIEW, targets }),
      commit: (request) => ({
        operationId: request.operationId,
        extent: request.extent,
        mode: request.mode,
        results: request.targets.map((target) => ({
          target,
          row: null,
          outcome: "moved",
        })),
      }),
    });
    for (const hostId of [HOST_ID, REMOTE_HOST, THIRD_HOST, "unrelated-host"]) {
      harness.queryClient.setQueryData(
        hostQueryKeys.methodScope(hostId, "agent.list"),
        ["before-move"],
      );
    }
    renderDialog(harness);
    await screen.findByText(
      "70 agents and bots are waiting on Source profile.",
    );
    await user.click(screen.getByRole("combobox"));
    await user.click(
      await screen.findByRole("option", { name: "Destination profile" }),
    );
    await user.click(screen.getByRole("button", { name: "Move 70" }));
    await screen.findByText("Moved 70 to Destination profile.");
    const commits = harness.messenger.calls.filter(
      (call) => call.method === "providers.commitProfileMove",
    );
    expect(
      commits.map((call) => ({
        hostId: call.authority.endpoint.hostId,
        request: providersCommitProfileMoveRequestSchema.parse(call.params),
        floor: call.requiredHostMethodVersion,
      })),
    ).toEqual(
      [HOST_ID, REMOTE_HOST, THIRD_HOST].map((hostId) => ({
        hostId,
        request: {
          operationId: harness.requests[0]?.operationId,
          extent: "this-computer",
          mode: "waiting",
          source: SOURCE,
          destinationProfileId: "destination-profile",
          targets: targets
            .filter((target) =>
              target.kind === "bot"
                ? hostId === HOST_ID
                : target.hostId === hostId,
            )
            .map((target) =>
              target.kind === "bot"
                ? { kind: "bot", botId: target.botId }
                : {
                    kind: "agent",
                    epicId: target.epicId,
                    agentId: target.agentId,
                  },
            ),
        },
        floor: {
          method: "providers.commitProfileMove",
          version: { major: 1, minor: 0 },
        },
      })),
    );
    expect(
      [HOST_ID, REMOTE_HOST, THIRD_HOST, "unrelated-host"].map(
        (hostId) =>
          harness.queryClient.getQueryState(
            hostQueryKeys.methodScope(hostId, "agent.list"),
          )?.isInvalidated,
      ),
    ).toEqual([true, true, true, false]);
  });

  it.each(["unreachable", "unsupported", "not-allowed"] as const)(
    "keeps a remote computer's %s result separate from the anchor's move",
    async (reason) => {
      const user = userEvent.setup();
      const remote = { ...AGENT_ROW, agentId: "remote", hostId: REMOTE_HOST };
      const harness = createHarness({
        preview: () => ({ ...PREVIEW, targets: [AGENT_ROW, remote] }),
        commit: (request) => {
          if (
            request.targets.some(
              (target) =>
                target.kind === "agent" && target.agentId === "remote",
            )
          ) {
            const details = {
              code: (
                {
                  unsupported: "E_HOST_UNSUPPORTED",
                  "not-allowed": "E_ROLE_FORBIDDEN",
                  unreachable: "RPC_ERROR",
                } as const
              )[reason],
              message: "synthetic remote refusal",
              method: "providers.commitProfileMove",
              requestId: "remote-refusal",
              fatalDetails: null,
            };
            throw reason === "unreachable"
              ? new HostTransportFailureError(details)
              : new HostRpcError(details);
          }
          return {
            operationId: request.operationId,
            extent: request.extent,
            mode: request.mode,
            results: request.targets.map((target) => ({
              target,
              row: null,
              outcome: "moved",
            })),
          };
        },
      });
      renderDialog(harness);
      await screen.findByText(
        "2 agents and bots are waiting on Source profile.",
      );
      await user.click(screen.getByRole("combobox"));
      await user.click(
        await screen.findByRole("option", { name: "Destination profile" }),
      );
      await user.click(screen.getByRole("button", { name: "Move 2" }));
      await screen.findByText("Moved 1 to Destination profile.");
      expect(
        await screen.findByText(
          {
            unreachable: `Computer ${REMOTE_HOST} can't be reached. These move when you run this again while it is online.`,
            unsupported: `Computer ${REMOTE_HOST} is running an older version`,
            "not-allowed": "You can't move this one",
          }[reason],
        ),
      ).toBeTruthy();
      expect(
        harness.messenger.calls
          .filter((call) => call.method === "providers.commitProfileMove")
          .map((call) => call.authority.endpoint.hostId),
      ).toEqual([HOST_ID, REMOTE_HOST]);
      expect(sonnerErrors.error.mock.calls).toHaveLength(0);
    },
  );

  it("retries the same owning-host bodies after a later host's answer is lost", async () => {
    const user = userEvent.setup();
    const remote = {
      ...AGENT_ROW,
      agentId: "remote-first",
      hostId: REMOTE_HOST,
    };
    let anchorCalls = 0;
    const harness = createHarness({
      preview: () => ({ ...PREVIEW, targets: [remote, AGENT_ROW] }),
      commit: (request) => {
        if (
          request.targets.some(
            (target) =>
              target.kind === "agent" && target.agentId === AGENT_ROW.agentId,
          )
        ) {
          anchorCalls += 1;
          if (anchorCalls === 1)
            throw new HostTransportFailureError({
              code: "RPC_ERROR",
              message: "unreachable",
              requestId: "lost-answer",
              method: "providers.commitProfileMove",
              fatalDetails: null,
            });
        }
        return {
          operationId: request.operationId,
          extent: request.extent,
          mode: request.mode,
          results: request.targets.map((target) => ({
            target,
            row: null,
            outcome: "moved",
          })),
        };
      },
    });
    const view = renderDialog(harness);
    await screen.findByText("2 agents and bots are waiting on Source profile.");
    await user.click(screen.getByRole("combobox"));
    await user.click(
      await screen.findByRole("option", { name: "Destination profile" }),
    );
    await user.click(screen.getByRole("button", { name: "Move 2" }));
    await screen.findByRole("heading", { name: "Still waiting" });
    view.rerender(
      <ProfileMoveDialog
        client={harness.client.createRequesterForHostId(THIRD_HOST)}
        source={{ ...SOURCE, profileId: "other-source" }}
        sourceLabel="Other source"
        profiles={PROFILES}
        onClose={vi.fn()}
        onRestartTerminal={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Move 2" }));
    await screen.findByText("Moved 2 to Destination profile.");
    const commits = harness.messenger.calls.filter(
      (call) => call.method === "providers.commitProfileMove",
    );
    expect(commits.map((call) => call.authority.endpoint.hostId)).toEqual([
      REMOTE_HOST,
      HOST_ID,
      REMOTE_HOST,
      HOST_ID,
    ]);
    expect(harness.requests.slice(2)).toEqual(harness.requests.slice(0, 2));
  });

  it("leaves a target pending when its named computer is absent, without sending it to another computer", async () => {
    const user = userEvent.setup();
    const remote = { ...AGENT_ROW, hostId: "absent-computer" };
    const harness = createHarness({
      preview: () => ({ ...PREVIEW, targets: [remote] }),
      commit: () => {
        throw new Error("No computer should receive this target");
      },
    });
    renderDialog(harness);
    await screen.findByText("1 agent is waiting on Source profile.");
    await user.click(screen.getByRole("combobox"));
    await user.click(
      await screen.findByRole("option", { name: "Destination profile" }),
    );
    await user.click(screen.getByRole("button", { name: "Move 1" }));
    await screen.findByText(
      "Computer absent-computer can't be reached. These move when you run this again while it is online.",
    );
    expect(harness.requests).toEqual([]);
    expect(sonnerErrors.error.mock.calls).toHaveLength(0);
  });

  it("rejects an owning computer's response for an unrequested target", async () => {
    const user = userEvent.setup();
    const remote = { ...AGENT_ROW, hostId: REMOTE_HOST };
    const harness = createHarness({
      preview: () => ({ ...PREVIEW, targets: [remote] }),
      commit: (request) => ({
        operationId: request.operationId,
        extent: request.extent,
        mode: request.mode,
        results: [
          {
            target: {
              kind: "agent",
              epicId: remote.epicId,
              agentId: "another-agent",
            },
            row: null,
            outcome: "moved",
          },
        ],
      }),
    });
    renderDialog(harness);
    await screen.findByText("1 agent is waiting on Source profile.");
    await user.click(screen.getByRole("combobox"));
    await user.click(
      await screen.findByRole("option", { name: "Destination profile" }),
    );
    await user.click(screen.getByRole("button", { name: "Move 1" }));
    await waitFor(() => expect(sonnerErrors.error.mock.calls).toHaveLength(1));
    expect(screen.queryByText("Moved 1 to Destination profile.")).toBeNull();
    expect(harness.requests).toHaveLength(1);
  });

  it("preserves the typed composer draft through a waiting profile move", async () => {
    const user = userEvent.setup();
    const harness = createHarness({
      preview: () => PREVIEW,
      commit: skippedBotResult,
    });
    const chatId = AGENT_ROW.agentId;
    const editorRef: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };
    const selectionRef: ComposerDraftSelectionRef = { current: null };
    const composer = (
      <ComposerDraftEditorHarness
        chatId={chatId}
        epicId={AGENT_ROW.epicId}
        hostId={HOST_ID}
        editorRef={editorRef}
        selectionRef={selectionRef}
      />
    );
    const view = render(<>{composer}</>, { wrapper: harness.Wrapper });

    await user.type(
      await screen.findByRole("textbox", { name: "test" }),
      "unsent profile move line",
    );
    const observe = () =>
      observeComposerDraft(
        chatId,
        editorRef,
        screen.getByTestId("composer-editor"),
      );
    const before = observe();
    expect(before.editorJSON).toBe(before.draftJSON);
    expect(before.visibleText).toBe("unsent profile move line");

    view.rerender(
      <>
        {composer}
        {dialogElement(harness, vi.fn())}
      </>,
    );
    await screen.findByText("2 agents and bots are waiting on Source profile.");
    const during = observe();
    expect(during).toEqual(before);

    await user.click(screen.getByRole("combobox"));
    await user.click(
      await screen.findByRole("option", { name: "Destination profile" }),
    );
    await user.click(screen.getByRole("button", { name: "Move 2" }));
    await screen.findByText("Moved 1 to Destination profile.");

    const after = observe();
    expect(after).toEqual(before);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.targets).toEqual([
      {
        kind: "agent",
        epicId: AGENT_ROW.epicId,
        agentId: AGENT_ROW.agentId,
      },
      { kind: "bot", botId: BOT_ROW.botId },
    ]);
  });

  it("counts previewed agents and bots, excludes terminals, and commits exactly the confirmed refs", async () => {
    const user = userEvent.setup();
    const harness = createHarness({
      preview: () => PREVIEW,
      commit: skippedBotResult,
    });
    renderDialog(harness);

    expect(
      await screen.findByText(
        "2 agents and bots are waiting on Source profile.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Terminal agents")).toBeTruthy();
    expect(screen.getByText("Terminal agent")).toBeTruthy();
    expect(harness.requests).toEqual([]);

    await user.click(screen.getByRole("combobox"));
    await user.click(
      await screen.findByRole("option", { name: "Destination profile" }),
    );
    await user.click(screen.getByRole("button", { name: "Move 2" }));

    await waitFor(() => expect(harness.requests).toHaveLength(1));
    expect(harness.requests[0]).toMatchObject({
      extent: "this-computer",
      mode: "waiting",
      source: SOURCE,
      destinationProfileId: "destination-profile",
      targets: [
        { kind: "agent", epicId: AGENT_ROW.epicId, agentId: AGENT_ROW.agentId },
        { kind: "bot", botId: BOT_ROW.botId },
      ],
    });
    expect(harness.requests[0]?.targets).not.toContainEqual({
      kind: "agent",
      epicId: TERMINAL.epicId,
      agentId: TERMINAL.agentId,
    });
    expect(
      await screen.findByText("Moved 1 to Destination profile."),
    ).toBeTruthy();
    const notMoved = screen
      .getByRole("heading", { name: "Not moved" })
      .closest("section");
    if (notMoved === null)
      throw new Error("Expected the skipped target section");
    expect(within(notMoved).getByText("Waiting bot")).toBeTruthy();
    expect(within(notMoved).getByText("No longer exists")).toBeTruthy();
  });

  it("re-reads the preview on each new dialog session", async () => {
    const harness = createHarness({
      preview: (_request, callIndex) =>
        callIndex === 0 ? PREVIEW : EMPTY_PREVIEW,
      commit: skippedBotResult,
    });
    const first = renderDialog(harness);
    expect(
      await screen.findByText(
        "2 agents and bots are waiting on Source profile.",
      ),
    ).toBeTruthy();
    first.unmount();

    renderDialog(harness);
    expect(
      await screen.findByText(
        "No agents or bots are waiting on Source profile.",
      ),
    ).toBeTruthy();
    expect(harness.previewCalls).toHaveLength(2);
  });

  it("keeps two open preview observers in their own count slots", async () => {
    const harness = createHarness({
      preview: (_request, callIndex) =>
        callIndex === 0
          ? PREVIEW
          : { ...PREVIEW, targets: [AGENT_ROW], terminals: [] },
      commit: skippedBotResult,
    });
    render(
      <>
        {dialogElement(harness, vi.fn())}
        {dialogElement(harness, vi.fn())}
      </>,
      { wrapper: harness.Wrapper },
    );

    expect(
      await screen.findByText(
        "2 agents and bots are waiting on Source profile.",
      ),
    ).toBeTruthy();
    expect(
      await screen.findByText("1 agent is waiting on Source profile."),
    ).toBeTruthy();
    expect(harness.previewCalls).toHaveLength(2);
  });

  it("shows the completed empty result separately from a preview failure", async () => {
    const harness = createHarness({
      preview: () => EMPTY_PREVIEW,
      commit: skippedBotResult,
    });
    renderDialog(harness);

    expect(
      await screen.findByText(
        "No agents or bots are waiting on Source profile.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move 0" })).toBeNull();
  });

  it("keeps an unreachable preview distinct from an empty waiting list", async () => {
    const harness = createHarness({
      preview: () => {
        throw new HostTransportFailureError({
          code: "RPC_ERROR",
          message: "unreachable",
          requestId: "move-dialog-request",
          method: "providers.previewProfileMove",
          fatalDetails: null,
        });
      },
      commit: skippedBotResult,
    });
    renderDialog(harness);

    expect(
      await screen.findByText(
        `Computer ${HOST_ID} can't be reached. Its agents are not counted and will not move now.`,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("No agents or bots are waiting on Source profile."),
    ).toBeNull();
  });

  it("shows distinct reasons for pending computers", async () => {
    const harness = createHarness({
      preview: () =>
        providersPreviewProfileMoveResponseSchema.parse({
          ...EMPTY_PREVIEW,
          pendingComputers: [
            { hostId: "host-unreachable", reason: "unreachable" },
            { hostId: "host-unsupported", reason: "unsupported" },
          ],
        }),
      commit: skippedBotResult,
    });
    renderDialog(harness);

    expect(
      await screen.findByText(
        "Computer host-unreachable can't be reached. Its agents are not counted and will not move now.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Computer host-unsupported is running an older version. Update it to move its agents.",
      ),
    ).toBeTruthy();
  });

  it("shows the approved older-computer notice when the preview method is unsupported", async () => {
    const harness = createHarness({
      preview: () => {
        throw new HostRpcError({
          code: "E_HOST_UNSUPPORTED",
          message: "unsupported",
          requestId: "move-dialog-request",
          method: "providers.previewProfileMove",
          fatalDetails: null,
        });
      },
      commit: skippedBotResult,
    });
    renderDialog(harness);

    expect(await screen.findByText(OLDER_COMPUTER_NOTICE)).toBeTruthy();
    expect(screen.queryByText(/waiting on Source profile/)).toBeNull();
  });

  it("shows the preview fallback toast for an ordinary RPC failure", async () => {
    const harness = createHarness({
      preview: () => {
        throw new HostRpcError({
          code: "RPC_ERROR",
          message: "synthetic preview failure",
          requestId: "move-dialog-request",
          method: "providers.previewProfileMove",
          fatalDetails: null,
        });
      },
      commit: skippedBotResult,
    });
    renderDialog(harness);

    await waitFor(() => expect(sonnerErrors.error.mock.calls).toHaveLength(1));
    expect(sonnerErrors.error.mock.calls[0]?.[0]).toBe(
      MOVE_ERROR_FALLBACKS.preview,
    );
    expect(
      screen.queryByText(/synthetic preview failure|RPC_ERROR/),
    ).toBeNull();
  });

  it("shows the older-computer notice when preview is below the dispatch floor", async () => {
    const harness = createHarness({
      preview: () => {
        throw moveFloorFailure("providers.previewProfileMove");
      },
      commit: skippedBotResult,
    });
    renderDialog(harness);

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toBe(OLDER_COMPUTER_NOTICE);
    expect(
      screen.queryByText(
        /DOWNGRADE_UNSUPPORTED|negotiated|not advertised|below the/,
      ),
    ).toBeNull();
    expect(sonnerErrors.error.mock.calls).toHaveLength(0);
  });

  it("shows the older-computer notice when commit is below the dispatch floor", async () => {
    const user = userEvent.setup();
    const harness = createHarness({
      preview: () => PREVIEW,
      commit: () => {
        throw moveFloorFailure("providers.commitProfileMove");
      },
    });
    renderDialog(harness);
    await screen.findByText("2 agents and bots are waiting on Source profile.");
    await user.click(screen.getByRole("combobox"));
    await user.click(
      await screen.findByRole("option", { name: "Destination profile" }),
    );
    await user.click(screen.getByRole("button", { name: "Move 2" }));

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toBe(OLDER_COMPUTER_NOTICE);
    expect(
      screen.queryByText(
        /DOWNGRADE_UNSUPPORTED|negotiated|not advertised|below the/,
      ),
    ).toBeNull();
    expect(sonnerErrors.error.mock.calls).toHaveLength(0);
  });

  it("shows the commit fallback toast for an ordinary RPC failure", async () => {
    const user = userEvent.setup();
    const harness = createHarness({
      preview: () => PREVIEW,
      commit: () => {
        throw new HostRpcError({
          code: "RPC_ERROR",
          message: "synthetic commit failure",
          requestId: "move-dialog-request",
          method: "providers.commitProfileMove",
          fatalDetails: null,
        });
      },
    });
    renderDialog(harness);
    await screen.findByText("2 agents and bots are waiting on Source profile.");
    await user.click(screen.getByRole("combobox"));
    await user.click(
      await screen.findByRole("option", { name: "Destination profile" }),
    );
    await user.click(screen.getByRole("button", { name: "Move 2" }));

    await waitFor(() => expect(sonnerErrors.error.mock.calls).toHaveLength(1));
    expect(sonnerErrors.error.mock.calls[0]?.[0]).toBe(
      MOVE_ERROR_FALLBACKS.commit,
    );
    expect(screen.queryByText(/synthetic commit failure|RPC_ERROR/)).toBeNull();
  });

  it("keeps the operation id and request body when a commit answer is lost", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const harness = createHarness({
      preview: () => PREVIEW,
      commit: (request) => {
        attempts += 1;
        if (attempts === 1)
          throw new HostTransportFailureError({
            code: "RPC_ERROR",
            message: "unreachable",
            requestId: "move-dialog-request",
            method: "providers.commitProfileMove",
            fatalDetails: null,
          });
        return skippedBotResult(request);
      },
    });
    renderDialog(harness);
    await screen.findByText("2 agents and bots are waiting on Source profile.");
    await user.click(screen.getByRole("combobox"));
    await user.click(
      await screen.findByRole("option", { name: "Destination profile" }),
    );
    await user.click(screen.getByRole("button", { name: "Move 2" }));
    await screen.findByRole("heading", { name: "Still waiting" });

    await user.click(screen.getByRole("button", { name: "Move 2" }));
    await waitFor(() => expect(harness.requests).toHaveLength(2));
    expect(harness.requests[1]).toEqual(harness.requests[0]);
    expect(harness.requests[1]?.operationId).toBe(
      harness.requests[0]?.operationId,
    );
    expect(
      await screen.findByRole("heading", { name: "Not moved" }),
    ).toBeTruthy();
  });
});
