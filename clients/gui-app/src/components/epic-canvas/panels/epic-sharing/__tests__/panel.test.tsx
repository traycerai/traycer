import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type {
  EpicCollaboratorView,
  EpicCollaboratorsView,
  EpicTeamCollaboratorView,
} from "@/hooks/epics/use-epic-collaborators-query";
import type { PermissionRole } from "@/lib/epic-collaborator-roles";
import { TooltipProvider } from "@/components/ui/tooltip";

interface TestState {
  role: PermissionRole;
  collaborators: EpicCollaboratorsView;
  shareableTeams: ReadonlyArray<{
    readonly teamId: string;
    readonly slug: string;
    readonly avatarUrl: string | null;
  }>;
  grantAccess: {
    readonly mutate: Mock;
    isPending: boolean;
    variables: unknown;
  };
  batchUpdateRoles: {
    readonly mutate: Mock;
    isPending: boolean;
    variables: unknown;
  };
  revokeCollaborator: {
    readonly mutate: Mock;
    isPending: boolean;
    variables: unknown;
  };
  sendInvites: {
    readonly mutateAsync: Mock;
    isPending: boolean;
  };
  collaboratorsQuery: {
    isFetching: boolean;
    dataUpdatedAt: number;
    readonly refetch: Mock;
  };
  sharingDefaultSupported: boolean;
  sharingInFlight: boolean;
  setSharingDefault: {
    readonly mutate: Mock;
    isPending: boolean;
  };
  ownCloudChats: ReadonlyArray<{
    readonly visibility: "private" | "task";
    readonly isOwnedByViewer: boolean;
  }>;
  cloudChatListSuccess: boolean;
}

const testState = vi.hoisted<TestState>(() => ({
  role: "owner",
  collaborators: { directUsers: [], teams: [], flatRows: [] },
  shareableTeams: [],
  grantAccess: { mutate: vi.fn(), isPending: false, variables: undefined },
  batchUpdateRoles: { mutate: vi.fn(), isPending: false, variables: undefined },
  revokeCollaborator: {
    mutate: vi.fn(),
    isPending: false,
    variables: undefined,
  },
  sendInvites: { mutateAsync: vi.fn(), isPending: false },
  collaboratorsQuery: { isFetching: false, dataUpdatedAt: 0, refetch: vi.fn() },
  sharingDefaultSupported: false,
  sharingInFlight: false,
  setSharingDefault: { mutate: vi.fn(), isPending: false },
  ownCloudChats: [],
  cloudChatListSuccess: true,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicPermissionRole: () => testState.role,
}));

// Captures the client the controller hands the list query, so the suite can
// say WHICH host the panel reads on - the two client mocks below answer
// different ids for exactly this reason.
const collaboratorsQueryClientIds = vi.hoisted(
  () => [] as Array<string | null>,
);

vi.mock("@/hooks/epics/use-epic-collaborators-query", () => ({
  EPIC_COLLABORATORS_OPEN_REFRESH_MS: 5 * 60_000,
  useEpicCollaboratorsQuery: (
    _epicId: string,
    options: {
      readonly client: { getActiveHostId: () => string | null } | null;
    },
  ) => ({
    ...(collaboratorsQueryClientIds.push(
      options.client?.getActiveHostId() ?? null,
    ),
    {}),
    data: testState.collaborators,
    error: null,
    isError: false,
    isFetching: testState.collaboratorsQuery.isFetching,
    isLoading: false,
    query: {
      dataUpdatedAt: testState.collaboratorsQuery.dataUpdatedAt,
      refetch: testState.collaboratorsQuery.refetch,
    },
  }),
}));

vi.mock("@/hooks/epic/use-epic-collaborator-mutations", () => ({
  useEpicGrantAccess: () => testState.grantAccess,
  useEpicBatchUpdateRoles: () => testState.batchUpdateRoles,
  useEpicRevokeCollaborator: () => testState.revokeCollaborator,
}));

vi.mock("@/hooks/epic/use-epic-send-queued-invites-mutation", () => ({
  useEpicSendQueuedInvites: () => testState.sendInvites,
}));

vi.mock("@/hooks/epic/use-epic-shareable-teams", () => ({
  useEpicShareableTeams: () => testState.shareableTeams,
}));

vi.mock("@/hooks/epic/use-chat-sharing-support", () => ({
  useChatSharingDefaultSupported: () => testState.sharingDefaultSupported,
  useCloudChatVisibilitySupported: () => false,
}));

vi.mock("@/hooks/epic/use-epic-chat-visibility-mutations", () => ({
  useEpicSetChatSharingDefault: () => testState.setSharingDefault,
  useEpicSetCloudChatVisibility: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/chats/use-cloud-chat-queries")
    >();
  return {
    ...actual,
    useCloudChatList: () =>
      testState.cloudChatListSuccess
        ? {
            data: { chats: testState.ownCloudChats },
            isEnabled: true,
            isSuccess: true,
            isError: false,
          }
        : {
            data: undefined,
            isEnabled: true,
            isSuccess: false,
            isError: false,
          },
    useCloudChatViewerId: () => "user-1",
  };
});

vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => ({ getActiveHostId: () => "active-host" }),
  // The SPINE, a separate export since redesign P2.1.
  useHostRuntimeClient: () => ({ getActiveHostId: () => "active-host" }),
}));

vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => ({ getActiveHostId: () => "epic-host" }),
}));

vi.mock("@/lib/chats/chat-sharing-inflight", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/chats/chat-sharing-inflight")>();
  return {
    ...actual,
    useChatSharingInFlight: () => testState.sharingInFlight,
  };
});

import { SharingPanel } from "../panel";
import { parseInviteIdentifier, validateInviteInput } from "@/lib/epic-invites";

const DIRECT_USER: EpicCollaboratorView = {
  accessSource: "direct-user",
  displayName: "Anurag Sharma",
  email: "anurag@example.com",
  handle: "anurag",
  avatarUrl: null,
  key: "user-1",
  teamId: null,
  teamName: null,
  role: "owner",
  userId: "user-1",
};

const DIRECT_EDITOR: EpicCollaboratorView = {
  accessSource: "direct-user",
  displayName: "Editor User",
  email: "editor@example.com",
  handle: "editor",
  avatarUrl: null,
  key: "user-2",
  teamId: null,
  teamName: null,
  role: "editor",
  userId: "user-2",
};

const SHARED_TEAM: EpicTeamCollaboratorView = {
  key: "team-team-1",
  teamId: "team-1",
  teamName: "traycerai",
  role: "viewer",
  members: [
    {
      accessSource: "team",
      displayName: "Team Member",
      email: "member@example.com",
      handle: "member",
      avatarUrl: null,
      key: "team-team-1-user-2",
      teamId: "team-1",
      teamName: "traycerai",
      role: "viewer",
      userId: "user-2",
    },
  ],
};

function resetTestState(): void {
  testState.role = "owner";
  testState.collaborators = {
    directUsers: [],
    teams: [],
    flatRows: [],
  };
  testState.shareableTeams = [];
  testState.grantAccess = {
    mutate: vi.fn(),
    isPending: false,
    variables: undefined,
  };
  testState.batchUpdateRoles = {
    mutate: vi.fn(),
    isPending: false,
    variables: undefined,
  };
  testState.revokeCollaborator = {
    mutate: vi.fn(),
    isPending: false,
    variables: undefined,
  };
  testState.sendInvites = { mutateAsync: vi.fn(), isPending: false };
  testState.collaboratorsQuery = {
    isFetching: false,
    dataUpdatedAt: 0,
    refetch: vi.fn(),
  };
  testState.sharingDefaultSupported = false;
  testState.sharingInFlight = false;
  testState.setSharingDefault = { mutate: vi.fn(), isPending: false };
  testState.ownCloudChats = [];
  testState.cloudChatListSuccess = true;
}

function renderSharingPanel(): void {
  render(
    <TooltipProvider>
      <SharingPanel epicId="epic-1" />
    </TooltipProvider>,
  );
}

describe("SharingPanel invite parsing", () => {
  it("classifies emails and GitHub handles with extension parity", () => {
    expect(parseInviteIdentifier("sharm@gmail.com")).toEqual({
      identifier: "sharm@gmail.com",
      identifierType: "email",
    });
    expect(parseInviteIdentifier("asjnfakjsnf")).toEqual({
      identifier: "asjnfakjsnf",
      identifierType: "github_handle",
    });
    expect(parseInviteIdentifier("@asjnfakjsnf")).toEqual({
      identifier: "asjnfakjsnf",
      identifierType: "github_handle",
    });
  });

  it("blocks duplicate queued identifiers by normalized type and value", () => {
    const parsedInvite = parseInviteIdentifier("@asjnfakjsnf");
    expect(
      validateInviteInput({
        parsedInvite,
        queuedInvites: [
          {
            identifier: "asjnfakjsnf",
            identifierType: "github_handle",
            role: "viewer",
          },
        ],
        isInvitePending: false,
      }),
    ).toEqual({
      inputError: "Already in the invite queue.",
      canAddInvite: false,
    });
  });
});

describe("<SharingPanel />", () => {
  beforeEach(() => {
    resetTestState();
  });

  afterEach(() => {
    cleanup();
  });

  it("queues email and GitHub chips with the batch invite label", async () => {
    testState.sendInvites.mutateAsync.mockResolvedValue({
      succeededInviteKeys: new Set<string>(),
      succeededNewInvites: [],
      succeededReInvites: [],
      failedInvites: [],
    });
    renderSharingPanel();

    const input = screen.getByTestId("invite-identifier-input");
    expect(screen.queryByTestId("invite-identifier-helper-slot")).toBeNull();
    fireEvent.change(input, { target: { value: "sharm@gmail.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByTestId("github-handle-invite-info")).toBeNull();
    fireEvent.change(input, { target: { value: "@asjnfakjsnf" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getAllByTestId("invite-queue-item")).toHaveLength(2);
    expect(screen.getByTestId("github-handle-invite-info")).toBeTruthy();
    expect(screen.getByText("sharm@gmail.com")).toBeTruthy();
    expect(screen.getByText("@asjnfakjsnf")).toBeTruthy();
    expect(screen.getByTestId("invite-send-button").textContent).toContain(
      "Invite 2 people",
    );

    fireEvent.click(screen.getByTestId("invite-send-button"));

    await waitFor(() => {
      expect(testState.sendInvites.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          epicId: "epic-1",
          queuedInvites: [
            {
              identifier: "sharm@gmail.com",
              identifierType: "email",
              role: "viewer",
            },
            {
              identifier: "asjnfakjsnf",
              identifierType: "github_handle",
              role: "viewer",
            },
          ],
        }),
      );
    });
  });

  it("reads the collaborator list on the EPIC SESSION's client, not the app-wide one", () => {
    // Codex #1243 sweep: the panel's grant/revoke/role mutations were moved
    // onto the Epic session's client, and the list must agree with the host
    // those writes land on. The controller's own comment recorded this as
    // deferred ("would have to move the mutation hooks with it"); this pins
    // that it is no longer deferred. Both client mocks are installed with
    // distinct ids, so a controller reading the app-wide client fails here
    // by name.
    collaboratorsQueryClientIds.length = 0;
    renderSharingPanel();
    expect(collaboratorsQueryClientIds.length).toBeGreaterThan(0);
    expect(new Set(collaboratorsQueryClientIds)).toEqual(
      new Set(["epic-host"]),
    );
  });

  it("renders direct people separately from shared and unshared teams", () => {
    testState.collaborators = {
      directUsers: [DIRECT_USER],
      teams: [SHARED_TEAM],
      flatRows: [DIRECT_USER, ...SHARED_TEAM.members],
    };
    testState.shareableTeams = [
      { teamId: "team-1", slug: "traycerai", avatarUrl: null },
      { teamId: "team-2", slug: "platform", avatarUrl: null },
    ];

    renderSharingPanel();

    expect(
      screen.getByTestId("epic-sharing-people-list").textContent,
    ).toContain("Anurag Sharma");
    expect(screen.getByTestId("epic-sharing-teams-list").textContent).toContain(
      "traycerai",
    );
    expect(screen.getByTestId("epic-sharing-teams-list").textContent).toContain(
      "platform",
    );
    expect(screen.getAllByTestId("team-share-button")).toHaveLength(1);
    expect(screen.getAllByTestId("team-revoke-button")).toHaveLength(1);
  });

  it("shows team access read-only for viewers", () => {
    testState.role = "viewer";
    testState.collaborators = {
      directUsers: [DIRECT_USER],
      teams: [SHARED_TEAM],
      flatRows: [DIRECT_USER, ...SHARED_TEAM.members],
    };
    testState.shareableTeams = [
      { teamId: "team-1", slug: "traycerai", avatarUrl: null },
      { teamId: "team-2", slug: "platform", avatarUrl: null },
    ];

    renderSharingPanel();

    expect(screen.queryByTestId("invite-card")).toBeNull();
    expect(screen.queryByTestId("team-share-button")).toBeNull();
    expect(screen.queryByTestId("team-revoke-button")).toBeNull();
    expect(screen.getByTestId("team-role-select-badge").textContent).toContain(
      "Viewer",
    );
    expect(
      screen.getByTestId("epic-sharing-teams-list").textContent,
    ).not.toContain("platform");
  });

  it("hides the teams section when non-owners have no shared teams", () => {
    testState.role = "viewer";
    testState.shareableTeams = [
      { teamId: "team-2", slug: "platform", avatarUrl: null },
    ];

    renderSharingPanel();

    expect(screen.queryByText("Teams")).toBeNull();
    expect(screen.queryByTestId("epic-sharing-teams-list")).toBeNull();
  });

  it("lets editors invite people without team management controls", () => {
    testState.role = "editor";
    testState.shareableTeams = [
      { teamId: "team-2", slug: "platform", avatarUrl: null },
    ];

    renderSharingPanel();

    expect(screen.getByTestId("invite-card")).toBeTruthy();
    expect(screen.queryByText("platform")).toBeNull();
    expect(screen.queryByTestId("team-share-button")).toBeNull();
  });

  it("shows an agent spinner while sharing a team", () => {
    testState.shareableTeams = [
      { teamId: "team-2", slug: "platform", avatarUrl: null },
    ];

    renderSharingPanel();
    fireEvent.click(screen.getByTestId("team-share-button"));

    expect(screen.getByTestId("team-share-button").textContent).toContain(
      "Share",
    );
    expect(testState.grantAccess.mutate).toHaveBeenCalledWith(
      {
        epicId: "epic-1",
        input: {
          kind: "team",
          teamId: "team-2",
          role: "viewer",
        },
      },
      expect.objectContaining({}),
    );
    expect(screen.getByTestId("team-share-spinner")).toBeTruthy();
  });

  it("shows the last-updated time and refreshes collaborators on demand", () => {
    testState.collaboratorsQuery = {
      isFetching: false,
      dataUpdatedAt: Date.now(),
      refetch: vi.fn(),
    };

    renderSharingPanel();

    expect(screen.getByText(/^Updated/)).toBeTruthy();

    fireEvent.click(screen.getByTestId("epic-sharing-refresh-button"));

    expect(testState.collaboratorsQuery.refetch).toHaveBeenCalledTimes(1);
  });

  it("spins the refresh icon while collaborators are refreshing", () => {
    testState.collaboratorsQuery = {
      isFetching: true,
      dataUpdatedAt: Date.now(),
      refetch: vi.fn(),
    };

    renderSharingPanel();

    expect(
      screen
        .getByTestId("epic-sharing-refresh-button")
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByTestId("epic-sharing-refresh-spinner").getAttribute("class"),
    ).toContain("animate-spin");
  });

  it("keeps role triggers visible for teams and direct collaborators", () => {
    testState.collaborators = {
      directUsers: [DIRECT_USER, DIRECT_EDITOR],
      teams: [SHARED_TEAM],
      flatRows: [DIRECT_USER, DIRECT_EDITOR, ...SHARED_TEAM.members],
    };
    testState.shareableTeams = [
      { teamId: "team-1", slug: "traycerai", avatarUrl: null },
    ];

    renderSharingPanel();

    expect(screen.getByTestId("team-role-select").textContent).toContain(
      "Viewer",
    );

    cleanup();
    resetTestState();
    testState.collaborators = {
      directUsers: [DIRECT_USER, DIRECT_EDITOR],
      teams: [],
      flatRows: [DIRECT_USER, DIRECT_EDITOR],
    };

    renderSharingPanel();

    expect(
      screen.getByTestId("collaborator-role-select").textContent,
    ).toContain("Editor");
  });
});

describe("<SharingPanel /> My agents", () => {
  beforeEach(() => {
    resetTestState();
  });

  afterEach(() => {
    cleanup();
  });

  it("hides the section when the host does not advertise the RPC", () => {
    renderSharingPanel();
    expect(screen.queryByTestId("epic-sharing-my-agents-section")).toBeNull();
  });

  it("keeps the switch inert until the cloud chat list has answered", () => {
    // The confirm copy counts the chats about to be exposed and the request
    // always applies to existing rows - so an unanswered list must not be
    // able to arm the toggle with a count of zero.
    testState.sharingDefaultSupported = true;
    testState.cloudChatListSuccess = false;
    testState.ownCloudChats = [
      { visibility: "private", isOwnedByViewer: true },
    ];

    renderSharingPanel();

    const toggle = screen.getByTestId("epic-sharing-my-agents-switch");
    expect(toggle.hasAttribute("disabled")).toBe(true);
    fireEvent.click(toggle);
    expect(screen.queryByTestId("epic-sharing-my-agents-confirm")).toBeNull();
  });

  it("shows the section to a viewer and derives on from any task-visible own row", () => {
    testState.role = "viewer";
    testState.sharingDefaultSupported = true;
    testState.ownCloudChats = [
      { visibility: "private", isOwnedByViewer: true },
      { visibility: "task", isOwnedByViewer: true },
    ];

    renderSharingPanel();

    expect(screen.queryByTestId("invite-card")).toBeNull();
    expect(screen.getByTestId("epic-sharing-my-agents-section")).toBeTruthy();
    expect(
      screen
        .getByTestId("epic-sharing-my-agents-switch")
        .getAttribute("data-state"),
    ).toBe("checked");
  });

  it("confirms the share direction with the count of chats about to become visible", () => {
    testState.sharingDefaultSupported = true;
    testState.ownCloudChats = [
      { visibility: "private", isOwnedByViewer: true },
      { visibility: "private", isOwnedByViewer: true },
      { visibility: "task", isOwnedByViewer: false },
    ];

    renderSharingPanel();

    fireEvent.click(screen.getByTestId("epic-sharing-my-agents-switch"));
    expect(
      screen.getByTestId("epic-sharing-my-agents-confirm").textContent,
    ).toContain("2 of your agent chats");

    fireEvent.click(
      screen.getByTestId("epic-sharing-my-agents-confirm-action"),
    );
    expect(testState.setSharingDefault.mutate).toHaveBeenCalledTimes(1);
    expect(testState.setSharingDefault.mutate.mock.calls[0]?.[0]).toEqual({
      taskId: "epic-1",
      defaultVisibility: "task",
      applyToExisting: true,
    });
  });

  it("confirms the private direction without a count", () => {
    testState.sharingDefaultSupported = true;
    testState.ownCloudChats = [{ visibility: "task", isOwnedByViewer: true }];

    renderSharingPanel();

    fireEvent.click(screen.getByTestId("epic-sharing-my-agents-switch"));
    expect(
      screen.getByTestId("epic-sharing-my-agents-confirm").textContent,
    ).toContain("Make your agents private?");
    expect(
      screen.getByTestId("epic-sharing-my-agents-confirm").textContent,
    ).toContain("all of your agents on this task private");
    expect(
      screen.getByTestId("epic-sharing-my-agents-confirm").textContent,
    ).not.toContain("will be able to view and clone");
  });

  it("disables the master toggle while any sharing write is in flight", () => {
    testState.sharingDefaultSupported = true;
    testState.sharingInFlight = true;
    testState.ownCloudChats = [
      { visibility: "private", isOwnedByViewer: true },
    ];

    renderSharingPanel();

    expect(
      screen
        .getByTestId("epic-sharing-my-agents-switch")
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByTestId("epic-sharing-my-agents-switch"));
    expect(screen.queryByTestId("epic-sharing-my-agents-confirm")).toBeNull();
  });
});
