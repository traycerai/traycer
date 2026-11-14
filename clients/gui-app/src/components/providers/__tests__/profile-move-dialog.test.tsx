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
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
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
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { ProfileMoveDialog } from "../profile-move-dialog";

vi.mock("@/hooks/providers/use-profile-move-computer-names", () => ({
  useProfileMoveComputerNames:
    () =>
    (hostId: string | null): string =>
      hostId === null ? "" : `Computer ${hostId}`,
}));

const HOST_ID = mockLocalHostEntry.hostId;
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
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) => (hostId === HOST_ID ? mockLocalHostEntry : null),
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

  return { client, requests, previewCalls, Wrapper };
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

afterEach(() => {
  cleanup();
});

afterAll(() => {
  vi.doUnmock("@/hooks/providers/use-profile-move-computer-names");
});

describe("ProfileMoveDialog", () => {
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
      extent: "fleet",
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

    expect(
      await screen.findByText(
        `Computer ${HOST_ID} is running an older version. Update it to move its agents.`,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/waiting on Source profile/)).toBeNull();
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
