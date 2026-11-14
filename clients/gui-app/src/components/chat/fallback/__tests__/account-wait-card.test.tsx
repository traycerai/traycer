import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  chatAccountWaitSchema,
  type ChatAccountWait,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  ProvidersPreviewProfileMoveRequest,
  ProvidersPreviewProfileMoveResponse,
} from "@traycer/protocol/host/profile-move-schemas";
import {
  providersPreviewProfileMoveRequestSchema,
  providersPreviewProfileMoveResponseSchema,
} from "@traycer/protocol/host/profile-move-schemas";
import {
  providersListResponseSchemaV1011Preimage,
  providersListResponseSchema,
  type ProvidersListResponse,
} from "@traycer/protocol/host/provider-schemas";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { commitProfileSelection } from "@/stores/composer/commit-selection";
import { ProfileDropdown } from "@/components/providers/profile-dropdown";
import { providerDisplayName } from "@/lib/provider-ordering";
import { resolveProfilePin } from "@/components/providers/provider-profile-model";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { AccountWaitSurface } from "../account-wait-card";
import { useChatAccountWait } from "../use-chat-account-wait";
import {
  pinProfile,
  providerState,
} from "@/components/providers/__tests__/profile-pin-fixtures";

interface WaitState {
  readonly accountWait: ChatAccountWait | null;
}

const mockState = vi.hoisted(() => ({
  sessions: new Map<string, { readonly store: StoreApi<WaitState> }>(),
  previewSupported: true,
  commitSupported: true,
  openSettings: vi.fn(),
  openAgent: vi.fn(),
}));

vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/registries/chat-session-registry")
    >();
  return {
    ...actual,
    useExistingChatSessionHandle: () =>
      mockState.sessions.get("active") ?? null,
  };
});

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: (_hostId: string, method: string): boolean =>
    method === "providers.previewProfileMove"
      ? mockState.previewSupported
      : mockState.commitSupported,
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: mockState.openSettings }),
}));

vi.mock("@/hooks/home-focus/use-focus-actions", () => ({
  useFocusActions: () => ({ openAgent: mockState.openAgent }),
}));

vi.mock("@/components/chat/composer/chat-composer-banner-portal", () => ({
  ChatComposerBannerPortal: (props: {
    readonly children: ReactNode;
  }): ReactNode => props.children,
}));

vi.mock("@/lib/layout-overrides", () => ({
  useReadingWidthStyle: () => ({ className: "", maxWidth: undefined }),
}));

vi.mock("@/components/ui/dropdown-menu", async () =>
  (
    await import("@/components/providers/__tests__/profile-dropdown-menu-mock")
  ).profileDropdownMenuMock(),
);

vi.mock("@/hooks/providers/use-profile-move-computer-names", () => ({
  useProfileMoveComputerNames:
    () =>
    (hostId: string | null): string =>
      hostId === null ? "" : `Computer ${hostId}`,
}));

const HOST_ID = mockLocalHostEntry.hostId;
const UNSUPPORTED_MOVE_METHODS: ReadonlyArray<
  readonly [string, boolean, boolean]
> = [
  ["preview", false, true],
  ["commit", true, false],
];
const PROFILE_A = pinProfile({
  profileId: "profile-a",
  label: "Source profile",
  kind: "managed",
  enabled: true,
  authStatus: "authenticated",
  aliases: [],
  personNotice: "needs-sign-in",
  terminalOnThisComputer: false,
  otherNames: [],
});
const PROFILE_B = pinProfile({
  profileId: "profile-b",
  label: "Destination profile",
  kind: "managed",
  enabled: true,
  authStatus: "authenticated",
  aliases: [],
  personNotice: null,
  terminalOnThisComputer: false,
  otherNames: [],
});
const SOURCE_WAIT: ChatAccountWait = chatAccountWaitSchema.parse({
  reason: "needs-sign-in",
  source: { providerId: "claude-code", profileId: PROFILE_A.profileId },
});
const WAIT_WITHOUT_SOURCE: ChatAccountWait = chatAccountWaitSchema.parse({
  reason: "needs-sign-in",
  source: null,
});

function providersList(
  offersSignIns: boolean | undefined,
): ProvidersListResponse {
  const providers = [
    providerState({
      providerId: "claude-code",
      authStatus: "authenticated",
      profiles: [PROFILE_A, PROFILE_B],
    }),
  ];
  return providersListResponseSchema.parse({
    providers,
    native: null,
    removedProfiles: [],
    ...(offersSignIns === undefined ? {} : { offersSignIns }),
  });
}

const TERMINAL_PREVIEW: ProvidersPreviewProfileMoveResponse =
  providersPreviewProfileMoveResponseSchema.parse({
    extent: "fleet",
    mode: "waiting",
    targets: [],
    terminals: [
      {
        epicId: "epic-terminal",
        agentId: "agent-terminal",
        hostId: HOST_ID,
        title: "Terminal agent",
      },
    ],
    pendingComputers: [],
  });

function toolbarStore(): ComposerToolbarStore {
  return createComposerToolbarStore({
    purpose: "run",
    reasoningFallback: "model-default",
    seedKey: "account-wait-test",
    values: {
      ultracode: false,
      permission: "supervised",
      selection: {
        harnessId: "claude",
        modelSlug: "claude-sonnet-4",
        profileId: PROFILE_A.profileId,
      },
      reasoning: "high",
      serviceTier: "",
    },
    onSettingsChange: () => undefined,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
    ultracodeCarried: false,
    hostId: HOST_ID,
  });
}

function ExistingProfilePicker(props: {
  readonly list: ProvidersListResponse;
  readonly toolbar: ComposerToolbarStore;
}): ReactNode {
  const provider = props.list.providers.find(
    (row) => row.providerId === "claude-code",
  );
  if (provider === undefined) return null;
  const profiles = provider.profiles;
  return (
    <ProfileDropdown
      providerLabel={providerDisplayName(provider.providerId)}
      profiles={profiles}
      pin={resolveProfilePin(
        profiles,
        [],
        props.toolbar.getState().selection.profileId,
      )}
      onSelectProfile={(profileId) =>
        commitProfileSelection(props.toolbar, profileId)
      }
      onCreateProfile={null}
      createProfileDisabled={false}
      createProfileDisabledReason={undefined}
      shortcutHintForIndex={() => null}
      profileEnablementPending={null}
      contentContainer={null}
      onCloseAutoFocus={null}
      usagePresentation={null}
      eligibilityControls={null}
      admissionByProfileId={null}
      showTerminalBadge
      terminalComputerName={null}
    />
  );
}

function createMoveClient(): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly previewRequests: ProvidersPreviewProfileMoveRequest[];
  readonly queryClient: QueryClient;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const previewRequests: ProvidersPreviewProfileMoveRequest[] = [];
  const previewAnswer: ResponseOfMethod<
    HostRpcRegistry,
    "providers.previewProfileMove"
  > = TERMINAL_PREVIEW;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "account-wait-request",
    handlers: {
      "providers.previewProfileMove": (
        params: ProvidersPreviewProfileMoveRequest,
      ): ResponseOfMethod<HostRpcRegistry, "providers.previewProfileMove"> => {
        previewRequests.push(
          providersPreviewProfileMoveRequestSchema.parse(params),
        );
        return previewAnswer;
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
      bearerToken: "tok-wait",
    }),
  );
  return {
    client: spine.createRequester(mockLocalHostEntry),
    previewRequests,
    queryClient,
  };
}

function WaitScene(props: {
  readonly list: ProvidersListResponse;
  readonly children: ReactNode;
  readonly toolbar: ComposerToolbarStore;
}): ReactNode {
  const wait = useChatAccountWait({
    fallbackCardVisible: false,
    providersList: props.list,
    epicId: "epic-test",
    chatId: "chat-test",
    hostId: HOST_ID,
  });
  return (
    <AccountWaitSurface
      epicId="epic-test"
      chatId="chat-test"
      providersList={props.list}
      wait={wait}
      client={null}
      hostId={HOST_ID}
      toolbarStore={props.toolbar}
      canAct
    >
      {props.children}
    </AccountWaitSurface>
  );
}

function renderWithClient(
  node: ReactNode,
  queryClient: QueryClient,
): RenderResult {
  return render(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>,
  );
}

beforeEach(() => {
  mockState.sessions.clear();
  mockState.sessions.set("active", {
    store: createStore<WaitState>()(() => ({ accountWait: SOURCE_WAIT })),
  });
  mockState.previewSupported = true;
  mockState.commitSupported = true;
  mockState.openSettings.mockClear();
  mockState.openAgent.mockClear();
});

afterEach(() => {
  cleanup();
  mockState.sessions.clear();
});

afterAll(() => {
  vi.doUnmock("@/lib/registries/chat-session-registry");
  vi.doUnmock("@/hooks/host/use-host-supports-method");
  vi.doUnmock("@/stores/tabs/use-system-tab-modal");
  vi.doUnmock("@/hooks/home-focus/use-focus-actions");
  vi.doUnmock("@/components/chat/composer/chat-composer-banner-portal");
  vi.doUnmock("@/lib/layout-overrides");
  vi.doUnmock("@/components/ui/dropdown-menu");
  vi.doUnmock("@/hooks/providers/use-profile-move-computer-names");
});

describe("account wait choices", () => {
  it.each([
    ["older list without offersSignIns", "absent"],
    ["list with offersSignIns false", "false"],
  ])(
    "preserves and configures through the existing picker for %s",
    async (_title, offerState) => {
      const user = userEvent.setup();
      const modern = providersList(true);
      const list =
        offerState === "absent"
          ? providersListResponseSchemaV1011Preimage.parse({
              ...modern,
              offersSignIns: true,
            })
          : providersList(false);
      const queryClient = new QueryClient();
      const toolbar = toolbarStore();
      renderWithClient(
        <WaitScene list={list} toolbar={toolbar}>
          <ExistingProfilePicker list={list} toolbar={toolbar} />
        </WaitScene>,
        queryClient,
      );

      expect(
        screen.getByRole("menuitem", { name: /Destination profile/ }),
      ).not.toBeNull();
      expect(
        screen.queryByRole("button", { name: "Sign in again" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Move all waiting agents" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Choose another profile" }),
      ).toBeNull();
      expect(mockState.openSettings).not.toHaveBeenCalled();
      expect(mockState.openAgent).not.toHaveBeenCalled();
      await user.click(
        screen.getByRole("menuitem", { name: /Destination profile/ }),
      );
      expect(toolbar.getState().selection.profileId).toBe(PROFILE_B.profileId);
      expect(mockState.openSettings).not.toHaveBeenCalled();
      expect(mockState.openAgent).not.toHaveBeenCalled();
    },
  );

  it("offers only Choose another profile when the wait has no named source", async () => {
    const user = userEvent.setup();
    const toolbar = toolbarStore();
    renderWithClient(
      <AccountWaitSurface
        epicId="epic-test"
        chatId="chat-test"
        providersList={providersList(true)}
        wait={WAIT_WITHOUT_SOURCE}
        client={null}
        hostId={HOST_ID}
        toolbarStore={toolbar}
        canAct
      >
        {null}
      </AccountWaitSurface>,
      new QueryClient(),
    );

    expect(
      screen.getByRole("button", { name: "Choose another profile" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Move all waiting agents" }),
    ).toBeNull();
    await user.click(
      screen.getByRole("menuitem", { name: /Destination profile/ }),
    );
    expect(toolbar.getState().selection.profileId).toBe(PROFILE_B.profileId);
  });

  it("offers sign-in again only for a needs-sign-in wait", () => {
    const toolbar = toolbarStore();
    renderWithClient(
      <AccountWaitSurface
        epicId="epic-test"
        chatId="chat-test"
        providersList={providersList(true)}
        wait={SOURCE_WAIT}
        client={null}
        hostId={HOST_ID}
        toolbarStore={toolbar}
        canAct
      >
        {null}
      </AccountWaitSurface>,
      new QueryClient(),
    );

    expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Move all waiting agents" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it.each(UNSUPPORTED_MOVE_METHODS)(
    "keeps the existing profile choice when the %s move method is unsupported",
    async (_method, previewSupported, commitSupported) => {
      const user = userEvent.setup();
      mockState.previewSupported = previewSupported;
      mockState.commitSupported = commitSupported;
      const fallbackToolbar = toolbarStore();
      renderWithClient(
        <AccountWaitSurface
          epicId="epic-test"
          chatId="chat-test"
          providersList={providersList(true)}
          wait={{ ...SOURCE_WAIT, reason: "waiting-for-traycer" }}
          client={null}
          hostId={HOST_ID}
          toolbarStore={fallbackToolbar}
          canAct
        >
          {null}
        </AccountWaitSurface>,
        new QueryClient(),
      );
      expect(
        screen.queryByRole("button", { name: "Sign in again" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Move all waiting agents" }),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: "Choose another profile" }),
      ).toBeTruthy();
      await user.click(
        screen.getByRole("menuitem", { name: /Destination profile/ }),
      );
      expect(fallbackToolbar.getState().selection.profileId).toBe(
        PROFILE_B.profileId,
      );
      expect(mockState.openSettings).not.toHaveBeenCalled();
      expect(mockState.openAgent).not.toHaveBeenCalled();
    },
  );

  it("routes a terminal row action to the existing agent focus with its exact identifiers", async () => {
    const user = userEvent.setup();
    const { client, previewRequests, queryClient } = createMoveClient();
    const toolbar = toolbarStore();
    renderWithClient(
      <AccountWaitSurface
        epicId="epic-test"
        chatId="chat-test"
        providersList={providersList(true)}
        wait={{ ...SOURCE_WAIT, reason: "waiting-for-traycer" }}
        client={client}
        hostId={HOST_ID}
        toolbarStore={toolbar}
        canAct
      >
        {null}
      </AccountWaitSurface>,
      queryClient,
    );

    await user.click(
      screen.getByRole("button", { name: "Move all waiting agents" }),
    );
    await screen.findByText("Terminal agent");
    expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Restart on another profile" }),
    );

    expect(previewRequests).toEqual([
      {
        extent: "fleet",
        mode: "waiting",
        source: { providerId: "claude-code", profileId: PROFILE_A.profileId },
      },
    ]);
    expect(mockState.openAgent).toHaveBeenCalledTimes(1);
    expect(mockState.openAgent).toHaveBeenCalledWith(
      "epic-terminal",
      "agent-terminal",
      HOST_ID,
    );
    expect(toolbar.getState().selection.profileId).toBe(PROFILE_A.profileId);
    expect(mockState.openSettings).not.toHaveBeenCalled();
  });
});
