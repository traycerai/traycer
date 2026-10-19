import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type {
  AuthenticatedUser,
  TraycerTeamSubscription,
} from "@traycer/protocol/auth";
import type { AgentReach } from "@traycer/protocol/host/agent/shared";
import type {
  TaskHostPrincipal,
  TaskHostRow,
} from "@traycer/protocol/host/task-host-summary";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  ChatTreeSurfaceContext,
  type ChatTreeSurface,
} from "@/components/epic-canvas/sidebar/chat-tree-surface";
import {
  teamSubscription,
  userSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";

interface TaskHostsState {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: { readonly code: string } | null;
  readonly data: { readonly hosts: readonly TaskHostRow[] } | undefined;
  readonly refetch: () => Promise<void>;
}

interface CollaboratorRowFixture {
  readonly userId: string | null;
  readonly displayName: string;
}

const mocks = vi.hoisted(() => ({
  /** The Epic session's client: an identity the hooks are called with. */
  client: { kind: "epic-session-client" },
  taskHosts: null as TaskHostsState | null,
  taskHostsCalls: [] as { client: object | null; taskId: string }[],
  /** Whether this session may spend the cloud capability. */
  cloudAuthorized: true,
  /** `ownerHostId` of every live cloud chat the task lists. */
  chatOwnerHostIds: [] as string[],
  /** `ownerHostId` of every archived cloud chat the task lists. */
  archivedChatOwnerHostIds: [] as string[],
  cloudChatCalls: [] as {
    client: object | null;
    taskId: string;
    enabled: boolean;
  }[],
  user: null as AuthenticatedUser | null,
  collaborators: [] as CollaboratorRowFixture[],
  collaboratorCalls: [] as { epicId: string; options: object }[],
  directory: [] as HostDirectoryEntry[],
  refetch: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => mocks.client,
}));
vi.mock("@/hooks/epic/use-task-hosts-query", () => ({
  useTaskHosts: (client: object | null, taskId: string) => {
    mocks.taskHostsCalls.push({ client, taskId });
    return mocks.taskHosts;
  },
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  // The collaborator read spends the cloud capability; this session has it.
  useCloudChatHasCloudAuthorization: () => mocks.cloudAuthorized,
  // A signed-in viewer; the grouping reads the viewer from the auth store.
  useCloudChatViewerId: () => "viewer-signed-in",
  useCloudChatList: (args: {
    client: object | null;
    taskId: string;
    enabled: boolean;
  }) => {
    mocks.cloudChatCalls.push(args);
    return {
      data: {
        chats: [
          ...mocks.chatOwnerHostIds.map((ownerHostId) => ({
            ownerHostId,
            isArchived: false,
          })),
          ...mocks.archivedChatOwnerHostIds.map((ownerHostId) => ({
            ownerHostId,
            isArchived: true,
          })),
        ],
      },
      isPending: false,
      isError: false,
    };
  },
}));
// The section reads the person's teams as the auth store projects them
// from their team subscriptions; the projection itself is the real one.
vi.mock("@/hooks/epic/use-epic-shareable-teams", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/epic/use-epic-shareable-teams")
    >();
  return {
    ...actual,
    useEpicShareableTeams: () => actual.projectShareableTeams(mocks.user),
  };
});
vi.mock("@/hooks/epics/use-epic-collaborators-query", () => ({
  useEpicCollaboratorsQuery: (epicId: string, options: object) => {
    mocks.collaboratorCalls.push({ epicId, options });
    return { data: { flatRows: mocks.collaborators } };
  },
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: mocks.directory,
    isPending: false,
    isError: false,
  }),
}));

import { TaskHostGroupsSection } from "@/components/epic-canvas/sidebar/task-host-groups";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";

const VIEWER = "u-viewer";
const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";

const OWN_HOST = "h-own";
const OWN_HOST_2 = "h-own-2";
const ANA_HOST = "h-ana";
const TEAM_HOST = "h-team";

function hostRow(
  hostId: string,
  label: string | null,
  principal: TaskHostPrincipal,
  reach: AgentReach,
): TaskHostRow {
  return { hostId, label, principal, reach };
}

function ownRow(hostId: string, label: string | null): TaskHostRow {
  return hostRow(hostId, label, { kind: "user", id: VIEWER }, "same_principal");
}

/** The proof's row: a collaborator's sandbox, not in the person's directory. */
function anaSandboxRow(): TaskHostRow {
  return hostRow(
    ANA_HOST,
    "ana-box",
    { kind: "user", id: "u-ana" },
    "other_principal",
  );
}

function teamHostRow(teamId: string): TaskHostRow {
  return hostRow(
    TEAM_HOST,
    "team-box",
    { kind: "team", id: teamId },
    "other_principal",
  );
}

function localEntry(
  hostId: string,
  label: string,
  online: boolean,
): HostDirectoryEntry {
  return {
    hostId,
    label,
    kind: "local",
    websocketUrl: null,
    version: null,
    transportDialability: online ? "dialable" : "not-dialable",
  };
}

/** A remote host the cloud has not said anything about: neither on nor off. */
function indeterminateRemoteEntry(
  hostId: string,
  label: string,
): RemoteHostDirectoryEntry {
  return {
    hostId,
    label,
    kind: "remote",
    websocketUrl: null,
    version: null,
    transportDialability: "not-dialable",
    publicKey: "pubkey",
    relayFuseGrace: false,
    sandbox: null,
    remoteStatus: {
      connectivity: "unknown",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
  };
}

function teamEntry(id: string, slug: string): TraycerTeamSubscription {
  const base = teamSubscription(1_000);
  return { ...base, teamID: id, team: { ...base.team, id, slug } };
}

function userInTeams(
  teams: readonly TraycerTeamSubscription[],
): AuthenticatedUser {
  return userWith(
    userSubscription({
      totalPlanCredits: 5,
      consumedFromPlan: 0,
      bonusCredits: 0,
      consumedFromBonus: 0,
      bundleRemaining: 0,
    }),
    [...teams],
  );
}

function showHosts(hosts: readonly TaskHostRow[]): void {
  mocks.taskHosts = {
    isPending: false,
    isError: false,
    error: null,
    data: { hosts },
    refetch: mocks.refetch,
  };
}

/** What the phone sheet provides; the desktop sidebar provides none. */
const PHONE_SURFACE: ChatTreeSurface = {
  onRowActivated: () => undefined,
  revealRowControls: true,
  searchQuery: null,
  startNewChat: () => undefined,
};

function mountSection(
  canMutate: boolean,
  surface: ChatTreeSurface | null,
): HTMLElement {
  return render(
    <ChatTreeSurfaceContext.Provider value={surface}>
      <TaskHostGroupsSection
        epicId={EPIC_ID}
        tabId={TAB_ID}
        canMutate={canMutate}
      />
    </ChatTreeSurfaceContext.Provider>,
  ).container;
}

/** The desktop sidebar, for a person who may start a chat. */
function mount(): HTMLElement {
  return mountSection(true, null);
}

function groupFor(key: string): HTMLElement {
  const group = screen
    .getAllByTestId("task-host-group")
    .find((candidate) => candidate.getAttribute("data-group-key") === key);
  if (group === undefined) throw new Error(`no group ${key}`);
  return group;
}

function rowFor(hostId: string): HTMLElement {
  const row = screen
    .getAllByTestId("task-host-row")
    .find((candidate) => candidate.getAttribute("data-host-id") === hostId);
  if (row === undefined) throw new Error(`no row ${hostId}`);
  return row;
}

beforeEach(() => {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: VIEWER, username: "viewer" },
  });
  mocks.taskHosts = null;
  mocks.taskHostsCalls.length = 0;
  mocks.cloudAuthorized = true;
  mocks.chatOwnerHostIds = [];
  mocks.archivedChatOwnerHostIds = [];
  mocks.cloudChatCalls.length = 0;
  mocks.user = userInTeams([]);
  mocks.collaborators = [];
  mocks.collaboratorCalls.length = 0;
  mocks.directory = [];
  mocks.refetch.mockReset();
  mocks.refetch.mockResolvedValue(undefined);
  useNewConversationModalOpenStore.getState().close();
});

afterEach(() => {
  cleanup();
  useNewConversationModalOpenStore.getState().close();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("<TaskHostGroupsSection /> what it reads", () => {
  it("asks for the task's hosts and chats through the Epic session's client", () => {
    showHosts([ownRow(OWN_HOST, "laptop")]);
    mount();

    expect(mocks.taskHostsCalls[0]).toEqual({
      client: mocks.client,
      taskId: EPIC_ID,
    });
    expect(mocks.cloudChatCalls[0]).toEqual({
      client: mocks.client,
      taskId: EPIC_ID,
      enabled: true,
    });
    expect(mocks.collaboratorCalls[0].epicId).toBe(EPIC_ID);
    expect(mocks.collaboratorCalls[0].options).toMatchObject({
      client: mocks.client,
      enabled: true,
    });
  });
});

describe("<TaskHostGroupsSection /> states with no list", () => {
  it("renders nothing while the hosts are pending", () => {
    mocks.taskHosts = {
      isPending: true,
      isError: false,
      error: null,
      data: undefined,
      refetch: mocks.refetch,
    };
    const container = mount();

    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("task-host-groups")).toBeNull();
    expect(screen.queryByTestId("task-host-groups-error")).toBeNull();
  });

  it("renders nothing for a task with no hosts", () => {
    showHosts([]);
    const container = mount();

    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("task-host-groups")).toBeNull();
    expect(screen.queryByTestId("task-host-groups-error")).toBeNull();
  });

  it("renders no section and no error for a host that predates the surface", () => {
    mocks.taskHosts = {
      isPending: false,
      isError: true,
      error: { code: "E_HOST_UNSUPPORTED" },
      data: undefined,
      refetch: mocks.refetch,
    };
    const container = mount();

    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("task-host-groups")).toBeNull();
    expect(screen.queryByTestId("task-host-groups-error")).toBeNull();
  });

  it("renders the error line for any other failure, and Try again refetches", () => {
    mocks.taskHosts = {
      isPending: false,
      isError: true,
      error: { code: "E_HOST_TIMEOUT" },
      data: undefined,
      refetch: mocks.refetch,
    };
    mount();

    expect(screen.queryByTestId("task-host-groups")).toBeNull();
    expect(screen.getByTestId("task-host-groups-error").textContent).toContain(
      "Couldn't load this task's hosts.",
    );

    const retry = screen.getByTestId("task-host-groups-retry");
    expect(retry.textContent).toContain("Try again");
    expect(mocks.refetch).not.toHaveBeenCalled();
    fireEvent.click(retry);
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });
});

describe("<TaskHostGroupsSection /> cloud authorization and a failed refetch", () => {
  it("renders no section when cloud authorization is withdrawn while data is cached", () => {
    mocks.cloudAuthorized = false;
    mocks.directory = [localEntry(OWN_HOST, "laptop", true)];
    showHosts([ownRow(OWN_HOST, "laptop")]);
    const container = mount();

    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("task-host-groups")).toBeNull();
    expect(screen.queryByTestId("task-host-row")).toBeNull();
    expect(screen.queryByTestId("task-host-groups-error")).toBeNull();
  });

  it("renders no error line either when authorization is withdrawn over a failure", () => {
    mocks.cloudAuthorized = false;
    mocks.taskHosts = {
      isPending: false,
      isError: true,
      error: { code: "E_HOST_TIMEOUT" },
      data: undefined,
      refetch: mocks.refetch,
    };
    const container = mount();

    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("task-host-groups-error")).toBeNull();
  });

  it("keeps the rows when a refetch fails over data already shown", () => {
    mocks.directory = [localEntry(OWN_HOST, "laptop", true)];
    mocks.taskHosts = {
      isPending: false,
      isError: true,
      error: { code: "E_HOST_TIMEOUT" },
      data: { hosts: [ownRow(OWN_HOST, "laptop")] },
      refetch: mocks.refetch,
    };
    mount();

    expect(screen.getByTestId("task-host-groups")).toBeDefined();
    expect(
      within(rowFor(OWN_HOST)).getByTestId("task-host-row-label").textContent,
    ).toBe("laptop");
    expect(screen.queryByTestId("task-host-groups-error")).toBeNull();
  });
});

describe("<TaskHostGroupsSection /> the section", () => {
  it("has a Hosts header and is open by default", () => {
    showHosts([ownRow(OWN_HOST, "laptop")]);
    mount();

    const section = screen.getByTestId("task-host-groups");
    expect(within(section).getByText("Hosts")).toBeDefined();
    const trigger = within(section).getByRole("button", { name: /Hosts/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByTestId("task-host-row")).toHaveLength(1);
  });

  it("collapses when the header is pressed", () => {
    showHosts([ownRow(OWN_HOST, "laptop")]);
    mount();

    const trigger = within(screen.getByTestId("task-host-groups")).getByRole(
      "button",
      { name: /Hosts/ },
    );
    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("groups by owner, Personal first, each group carrying its key and title", () => {
    mocks.user = userInTeams([teamEntry("team-acme", "acme")]);
    mocks.collaborators = [{ userId: "u-ana", displayName: "Ana" }];
    showHosts([
      anaSandboxRow(),
      teamHostRow("team-acme"),
      ownRow(OWN_HOST, "laptop"),
    ]);
    mount();

    const groups = screen.getAllByTestId("task-host-group");
    expect(groups.map((group) => group.getAttribute("data-group-key"))).toEqual(
      ["personal", "team:team-acme", "user:u-ana"],
    );
    expect(
      groups.map(
        (group) =>
          within(group).getByTestId("task-host-group-title").textContent,
      ),
    ).toEqual(["Personal", "acme", "Ana's"]);
  });
});

describe("<TaskHostGroupsSection /> a collaborator's sandbox (the proof)", () => {
  beforeEach(() => {
    mocks.collaborators = [
      { userId: "u-ana", displayName: "Ana" },
      { userId: null, displayName: "Someone with no id" },
    ];
    mocks.directory = [localEntry(OWN_HOST, "laptop", true)];
    showHosts([anaSandboxRow(), ownRow(OWN_HOST, "laptop")]);
    mount();
  });

  it("shows its label, the owner's group and the reach line", () => {
    const group = groupFor("user:u-ana");
    const row = rowFor(ANA_HOST);

    expect(within(group).getByTestId("task-host-group-title").textContent).toBe(
      "Ana's",
    );
    expect(group.contains(row)).toBe(true);
    expect(within(row).getByTestId("task-host-row-label").textContent).toBe(
      "ana-box",
    );
    expect(
      within(row).getByTestId("task-host-row-unreachable").textContent,
    ).toBe("not reachable from this host");
  });

  it("shows no state of any kind, because nothing the person may read says one", () => {
    const row = rowFor(ANA_HOST);

    expect(within(row).queryByTestId("task-host-row-state")).toBeNull();
    expect(within(row).queryByText(/Online/i)).toBeNull();
    expect(within(row).queryByText(/Offline/i)).toBeNull();
  });

  it("has no New chat and no button or link at all", () => {
    const row = rowFor(ANA_HOST);

    expect(within(row).queryByTestId("task-host-row-new-chat")).toBeNull();
    expect(within(row).queryByText("New chat on this host")).toBeNull();
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
    expect(
      row.querySelectorAll("button, [role='button'], a[href]"),
    ).toHaveLength(0);
  });

  it("has no menu, no menu item and no menu trigger", () => {
    const row = rowFor(ANA_HOST);

    expect(within(row).queryAllByRole("menu")).toHaveLength(0);
    expect(within(row).queryAllByRole("menuitem")).toHaveLength(0);
    expect(
      row.querySelectorAll(
        "[aria-haspopup], [data-slot='dropdown-menu-trigger'], [role='menu'], [role='menuitem']",
      ),
    ).toHaveLength(0);
  });

  it("shows no cost and no settings", () => {
    const row = rowFor(ANA_HOST);
    const text = row.textContent;

    expect(text).not.toMatch(/credits/i);
    expect(text).not.toContain("$");
    expect(text).not.toContain("/h");
    expect(text).not.toMatch(/settings/i);
  });

  it("leaves the person's own row beside it with its New chat", () => {
    const own = rowFor(OWN_HOST);

    expect(within(own).getByTestId("task-host-row-new-chat")).toBeDefined();
    expect(within(own).queryByTestId("task-host-row-unreachable")).toBeNull();
  });
});

describe("<TaskHostGroupsSection /> a collaborator's sandbox that is in the person's directory", () => {
  beforeEach(() => {
    mocks.collaborators = [{ userId: "u-ana", displayName: "Ana" }];
    mocks.directory = [localEntry(ANA_HOST, "directory-name", true)];
    showHosts([anaSandboxRow()]);
    mount();
  });

  it("still shows the server's label and the reach line, never the directory's name", () => {
    const row = rowFor(ANA_HOST);

    expect(within(row).getByTestId("task-host-row-label").textContent).toBe(
      "ana-box",
    );
    expect(
      within(row).getByTestId("task-host-row-unreachable").textContent,
    ).toBe("not reachable from this host");
    expect(row.textContent).not.toContain("directory-name");
  });

  it("still shows no state, no New chat and no button", () => {
    const row = rowFor(ANA_HOST);

    expect(within(row).queryByTestId("task-host-row-state")).toBeNull();
    expect(within(row).queryByText(/Online/i)).toBeNull();
    expect(within(row).queryByTestId("task-host-row-new-chat")).toBeNull();
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
  });
});

describe("<TaskHostGroupsSection /> when New chat on this host is offered", () => {
  beforeEach(() => {
    mocks.directory = [localEntry(OWN_HOST, "laptop", true)];
    showHosts([ownRow(OWN_HOST, "laptop")]);
  });

  it("is offered to an editor on the desktop sidebar", () => {
    mountSection(true, null);

    expect(
      within(rowFor(OWN_HOST)).getByTestId("task-host-row-new-chat"),
    ).toBeDefined();
  });

  it("is not offered when the person cannot mutate, but the row still shows its state", () => {
    mountSection(false, null);

    const row = rowFor(OWN_HOST);
    expect(within(row).queryByTestId("task-host-row-new-chat")).toBeNull();
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
    expect(within(row).getByTestId("task-host-row-state").textContent).toBe(
      "Online",
    );
    expect(within(row).getByTestId("task-host-row-label").textContent).toBe(
      "laptop",
    );
  });

  it("is not offered on the phone sheet, which has no New Conversation modal", () => {
    mountSection(true, PHONE_SURFACE);

    const row = rowFor(OWN_HOST);
    expect(within(row).queryByTestId("task-host-row-new-chat")).toBeNull();
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
    expect(useNewConversationModalOpenStore.getState().request).toBeNull();
  });

  it("is not offered when the person cannot mutate and the surface is the sheet", () => {
    mountSection(false, PHONE_SURFACE);

    expect(
      within(rowFor(OWN_HOST)).queryByTestId("task-host-row-new-chat"),
    ).toBeNull();
  });
});

describe("<TaskHostGroupsSection /> the person's own host", () => {
  it("shows Online and opens a chat on that host, and no unreachable line", () => {
    mocks.directory = [localEntry(OWN_HOST, "laptop", true)];
    showHosts([ownRow(OWN_HOST, "laptop")]);
    mount();

    const row = rowFor(OWN_HOST);
    expect(within(row).getByTestId("task-host-row-label").textContent).toBe(
      "laptop",
    );
    expect(within(row).getByTestId("task-host-row-state").textContent).toBe(
      "Online",
    );
    expect(within(row).queryByTestId("task-host-row-unreachable")).toBeNull();

    const button = within(row).getByTestId("task-host-row-new-chat");
    expect(button.textContent).toContain("New chat on this host");
    expect(useNewConversationModalOpenStore.getState().request).toBeNull();
    fireEvent.click(button);

    expect(useNewConversationModalOpenStore.getState().request).toEqual({
      epicId: EPIC_ID,
      tabId: TAB_ID,
      placement: null,
      parentId: null,
      hostId: OWN_HOST,
    });
  });

  it("shows Offline for a directory host that is not dialable", () => {
    mocks.directory = [localEntry(OWN_HOST, "laptop", false)];
    showHosts([ownRow(OWN_HOST, "laptop")]);
    mount();

    const row = rowFor(OWN_HOST);
    expect(within(row).getByTestId("task-host-row-state").textContent).toBe(
      "Offline",
    );
    expect(within(row).queryByTestId("task-host-row-unreachable")).toBeNull();
  });

  it("shows no state when the directory cannot say, but still offers New chat", () => {
    mocks.directory = [indeterminateRemoteEntry(OWN_HOST, "cloud-box")];
    showHosts([ownRow(OWN_HOST, null)]);
    mount();

    const row = rowFor(OWN_HOST);
    expect(within(row).getByTestId("task-host-row-label").textContent).toBe(
      "cloud-box",
    );
    expect(within(row).queryByTestId("task-host-row-state")).toBeNull();
    expect(within(row).getByTestId("task-host-row-new-chat")).toBeDefined();
  });

  it("shows no state and no New chat for a personal host missing from the directory, never Offline", () => {
    showHosts([ownRow(OWN_HOST, "laptop")]);
    mount();

    const row = rowFor(OWN_HOST);
    expect(within(row).queryByTestId("task-host-row-state")).toBeNull();
    expect(within(row).queryByText(/Offline/i)).toBeNull();
    expect(within(row).queryByTestId("task-host-row-new-chat")).toBeNull();
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
  });

  it("names a host with neither a server label nor a directory entry Unnamed host", () => {
    showHosts([ownRow(OWN_HOST, null)]);
    mount();

    expect(
      within(rowFor(OWN_HOST)).getByTestId("task-host-row-label").textContent,
    ).toBe("Unnamed host");
  });
});

describe("<TaskHostGroupsSection /> a team's host", () => {
  it("is titled by the team's slug when the person is in that team", () => {
    mocks.user = userInTeams([teamEntry("team-acme", "acme")]);
    showHosts([teamHostRow("team-acme")]);
    mount();

    expect(
      within(groupFor("team:team-acme")).getByTestId("task-host-group-title")
        .textContent,
    ).toBe("acme");
    expect(
      within(rowFor(TEAM_HOST)).getByTestId("task-host-row-unreachable")
        .textContent,
    ).toBe("not reachable from this host");
  });

  it("is titled A team when the person is not in that team", () => {
    mocks.user = userInTeams([teamEntry("team-other", "other")]);
    showHosts([teamHostRow("team-acme")]);
    mount();

    expect(
      within(groupFor("team:team-acme")).getByTestId("task-host-group-title")
        .textContent,
    ).toBe("A team");
  });

  it("is titled A team before the person has loaded", () => {
    mocks.user = null;
    showHosts([teamHostRow("team-acme")]);
    mount();

    expect(
      within(groupFor("team:team-acme")).getByTestId("task-host-group-title")
        .textContent,
    ).toBe("A team");
  });
});

describe("<TaskHostGroupsSection /> agent counts", () => {
  it("reads 1 agent and 2 agents from the task's cloud chats by owner host", () => {
    mocks.chatOwnerHostIds = [OWN_HOST, OWN_HOST_2, OWN_HOST_2];
    showHosts([ownRow(OWN_HOST, "laptop"), ownRow(OWN_HOST_2, "desktop")]);
    mount();

    expect(
      within(rowFor(OWN_HOST)).getByTestId("task-host-row-agents").textContent,
    ).toBe("1 agent");
    expect(
      within(rowFor(OWN_HOST_2)).getByTestId("task-host-row-agents")
        .textContent,
    ).toBe("2 agents");
  });

  it("reads 1 agent from two chats on a host when one of them is archived", () => {
    mocks.chatOwnerHostIds = [OWN_HOST];
    mocks.archivedChatOwnerHostIds = [OWN_HOST];
    showHosts([ownRow(OWN_HOST, "laptop")]);
    mount();

    expect(
      within(rowFor(OWN_HOST)).getByTestId("task-host-row-agents").textContent,
    ).toBe("1 agent");
  });

  it("shows no agents line for a host with only archived chats", () => {
    mocks.archivedChatOwnerHostIds = [OWN_HOST, OWN_HOST];
    showHosts([ownRow(OWN_HOST, "laptop")]);
    mount();

    expect(
      within(rowFor(OWN_HOST)).queryByTestId("task-host-row-agents"),
    ).toBeNull();
  });

  it("shows no agents line for a host that owns no chat", () => {
    mocks.chatOwnerHostIds = [OWN_HOST];
    showHosts([ownRow(OWN_HOST, "laptop"), ownRow(OWN_HOST_2, "desktop")]);
    mount();

    expect(
      within(rowFor(OWN_HOST_2)).queryByTestId("task-host-row-agents"),
    ).toBeNull();
  });
});
