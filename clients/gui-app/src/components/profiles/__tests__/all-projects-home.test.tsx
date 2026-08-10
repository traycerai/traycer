import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestRouterProvider } from "@/__tests__/with-test-router";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { activateTabIntent } from "@/lib/tab-navigation";
import { useHistoryMembershipCacheStore } from "@/stores/profiles/history-membership-cache-store";
import { useProjectProfilesStore } from "@/stores/profiles/project-profiles-store";
import { AllProjectsHome } from "../all-projects-home";

const mockNavigate = vi.fn(() => Promise.resolve());

vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("@/hooks/home/use-history-query", () => ({
  useHistoryQuery: () => ({
    data: undefined,
    isPending: false,
    isFetching: false,
    error: null,
    hostId: null,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  }),
}));

vi.mock("@/hooks/workspace/use-workspace-folder-actions", () => ({
  useWorkspaceFolderActions: () => ({
    pickAndPrepareFolders: vi.fn(() => Promise.resolve(null)),
    isPreparing: false,
    isRemoving: false,
    prepareFoldersMutation: {},
    removeEpicRepoMutation: {},
  }),
}));

vi.mock("@/lib/tab-navigation", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/tab-navigation")>();
  return { ...actual, activateTabIntent: vi.fn(() => true) };
});

function historyItem(overrides: {
  readonly epicId: string;
  readonly title: string | undefined;
  readonly updatedAtMs: number;
  readonly updatedLabel: string | undefined;
  readonly linkedWorkspaces: ReadonlyArray<{
    readonly hostId: string;
    readonly workspacePath: string;
  }>;
}): HistoryItem {
  return {
    id: overrides.epicId,
    epicId: overrides.epicId,
    taskType: "epic",
    title: overrides.title ?? overrides.epicId,
    initialUserPrompt: "",
    updatedAtMs: overrides.updatedAtMs,
    updatedLabel: overrides.updatedLabel ?? "1h ago",
    updatedBucket: "today",
    linkedRepos: [],
    linkedWorkspaces: overrides.linkedWorkspaces,
    pullRequestNumbers: [],
    worktreeBranches: [],
    worktreePaths: [],
    ownership: "mine",
    permissionRole: null,
    isPinned: false,
  };
}

function resetStores(): void {
  useProjectProfilesStore.getState().resetForTests();
  useHistoryMembershipCacheStore.getState().resetForTests();
}

function renderHome(): ReturnType<typeof render> {
  return render(
    <TestRouterProvider>
      <AllProjectsHome />
    </TestRouterProvider>,
  );
}

describe("AllProjectsHome", () => {
  beforeEach(() => {
    vi.mocked(activateTabIntent).mockClear();
    mockNavigate.mockClear();
    resetStores();
  });

  afterEach(() => {
    cleanup();
    resetStores();
  });

  it("renders per-profile owned epics and unassigned rescue", async () => {
    const titanos = useProjectProfilesStore.getState().createProfile({
      name: "Acme",
      icon: "rocket",
      color: "blue",
      folders: [{ path: "/Users/x/Acme", hostId: "h1" }],
    });
    const bagisto = useProjectProfilesStore.getState().createProfile({
      name: "Bagisto",
      icon: "store",
      color: "green",
      folders: [{ path: "/Users/x/Bagisto", hostId: "h1" }],
    });
    useProjectProfilesStore
      .getState()
      .assignEpicsToProfile(bagisto.id, ["epic-b"]);

    useHistoryMembershipCacheStore.getState().setMembershipItems([
      historyItem({
        epicId: "epic-a",
        title: "Epic A",
        updatedAtMs: 300,
        updatedLabel: "3h",
        linkedWorkspaces: [
          { hostId: "h1", workspacePath: "/Users/x/Acme" },
        ],
      }),
      historyItem({
        epicId: "epic-b",
        title: "Epic B",
        updatedAtMs: 200,
        updatedLabel: "2h",
        linkedWorkspaces: [],
      }),
      historyItem({
        epicId: "epic-c",
        title: "Epic C",
        updatedAtMs: 100,
        updatedLabel: "1h",
        linkedWorkspaces: [],
      }),
    ]);

    renderHome();

    await waitFor(() => {
      expect(
        screen.getByTestId(`all-projects-profile-card-${titanos.id}`),
      ).toBeTruthy();
    });

    const titanosCard = screen.getByTestId(
      `all-projects-profile-card-${titanos.id}`,
    );
    expect(titanosCard.textContent).toContain("Epic A");
    expect(titanosCard.textContent).not.toContain("Epic B");
    expect(titanosCard.textContent).not.toContain("Epic C");

    const bagistoCard = screen.getByTestId(
      `all-projects-profile-card-${bagisto.id}`,
    );
    expect(bagistoCard.textContent).toContain("Epic B");
    expect(bagistoCard.textContent).not.toContain("Epic A");

    expect(screen.getByTestId("all-projects-unassigned-epic-c")).toBeTruthy();
    expect(screen.queryByTestId("all-projects-unassigned-epic-a")).toBeNull();
    expect(screen.queryByTestId("all-projects-unassigned-epic-b")).toBeNull();
  });

  it("assigning an unassigned epic calls the store", async () => {
    const user = userEvent.setup();
    const titanos = useProjectProfilesStore.getState().createProfile({
      name: "Acme",
      icon: "rocket",
      color: "blue",
      folders: [{ path: "/Users/x/Acme", hostId: "h1" }],
    });
    useHistoryMembershipCacheStore.getState().setMembershipItems([
      historyItem({
        epicId: "epic-c",
        title: "Epic C",
        updatedAtMs: 100,
        updatedLabel: "1h",
        linkedWorkspaces: [],
      }),
    ]);
    const assignSpy = vi.spyOn(
      useProjectProfilesStore.getState(),
      "assignEpicsToProfile",
    );

    renderHome();

    await waitFor(() => {
      expect(screen.getByTestId("all-projects-assign-epic-c")).toBeTruthy();
    });

    await user.click(screen.getByTestId("all-projects-assign-epic-c"));
    await user.click(
      screen.getByTestId(`all-projects-assign-to-${titanos.id}-epic-c`),
    );

    expect(assignSpy).toHaveBeenCalledWith(titanos.id, ["epic-c"]);
    assignSpy.mockRestore();
  });

  it("clicking a card epic opens it via activateTabIntent", async () => {
    const user = userEvent.setup();
    useProjectProfilesStore.getState().createProfile({
      name: "Acme",
      icon: "rocket",
      color: "blue",
      folders: [{ path: "/Users/x/Acme", hostId: "h1" }],
    });
    useHistoryMembershipCacheStore.getState().setMembershipItems([
      historyItem({
        epicId: "epic-a",
        title: "Epic A",
        updatedAtMs: 100,
        updatedLabel: "1h",
        linkedWorkspaces: [
          { hostId: "h1", workspacePath: "/Users/x/Acme" },
        ],
      }),
    ]);

    renderHome();

    await waitFor(() => {
      expect(screen.getByTestId("all-projects-epic-epic-a")).toBeTruthy();
    });
    await user.click(screen.getByTestId("all-projects-epic-epic-a"));

    expect(vi.mocked(activateTabIntent)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(activateTabIntent).mock.calls[0];
    expect(call[1]).toMatchObject({ kind: "open-epic", epicId: "epic-a" });
  });

  it("zero profiles shows empty state", async () => {
    renderHome();

    await waitFor(() => {
      expect(screen.getByTestId("all-projects-home-empty")).toBeTruthy();
    });
    expect(
      screen.getByText(
        /Create a project profile to keep workspaces, tabs and chats separate/,
      ),
    ).toBeTruthy();
  });

  it("New chat mints a draft via activateTabIntent", async () => {
    const user = userEvent.setup();
    useProjectProfilesStore.getState().createProfile({
      name: "Acme",
      icon: "rocket",
      color: "blue",
      folders: [{ path: "/Users/x/Acme", hostId: "h1" }],
    });

    renderHome();

    await waitFor(() => {
      expect(screen.getByTestId("all-projects-new-chat")).toBeTruthy();
    });
    await user.click(screen.getByTestId("all-projects-new-chat"));

    expect(vi.mocked(activateTabIntent)).toHaveBeenCalledTimes(1);
    const [, intent] = vi.mocked(activateTabIntent).mock.calls[0];
    expect(intent.kind).toBe("new-draft");
  });
});
