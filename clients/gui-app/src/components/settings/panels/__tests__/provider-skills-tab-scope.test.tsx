import type {
  ProviderNativeScope,
  ProviderSkill,
  ProvidersSkillsMutateAction,
} from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderSkillsTab } from "@/components/settings/panels/provider-skills-tab";
import {
  nativeScopeFolderActionMocks,
  nativeScopeResolvedWorkspaceMocks,
  nativeScopeWorktreeMocks,
  resetNativeScopeTestMocks,
} from "@/components/settings/panels/__tests__/provider-native-scope-test-mocks";
import { useProvidersWorkspaceSelectionStore } from "@/stores/settings/providers-workspace-selection-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";

/**
 * F5: Skills tab reuses `useProviderNativeScope` + `McpScopePicker` with
 * locationLabel "Skills location". Global/project is WHERE skill files live;
 * composer's "Available to" / providerScoped is a different axis and must not
 * be conflated here.
 */

const skillMocks = vi.hoisted(() => ({
  skills: [] as ProviderSkill[],
  listCalls: [] as Array<{
    providerId: string;
    scope: string;
    workspaceRoot: string | null;
    enabled: boolean;
  }>,
  mutate: vi.fn(),
  mutateCalls: [] as Array<{
    providerId: string;
    scope: ProviderNativeScope;
    workspaceRoot: string | null;
    mutation: ProvidersSkillsMutateAction;
    suppressToast: boolean;
  }>,
  mutateIsPending: false,
  removeScopes: [] as ProviderNativeScope[],
  createScopes: [] as ProviderNativeScope[],
  importScopes: [] as ProviderNativeScope[],
  listScopes: [] as ProviderNativeScope[],
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-1",
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({
    getActiveHostId: () => "host-1",
  }),
  useHostBinding: () => ({
    hostClient: {
      getActiveHostId: () => "host-1",
    },
  }),
}));

vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => ({
    folders: nativeScopeResolvedWorkspaceMocks.folders,
    isLoading: nativeScopeResolvedWorkspaceMocks.isLoading,
    isFetching: nativeScopeResolvedWorkspaceMocks.isFetching,
  }),
}));

vi.mock("@/hooks/workspace/use-workspace-folder-actions", () => ({
  useWorkspaceFolderActionsForClient: () => ({
    isPreparing: nativeScopeFolderActionMocks.isPreparing,
    isRemoving: false,
    prepareFoldersMutation: null,
    removeEpicRepoMutation: null,
    pickAndPrepareFolders: nativeScopeFolderActionMocks.pickAndPrepareFolders,
  }),
  preparedWorkspaceFolderToWorkspaceFolderInfo: (
    folder: { workspacePath: string; workspaceName: string },
    hostId: string | null,
  ) => ({
    path: folder.workspacePath,
    name: folder.workspaceName,
    repoIdentifier: null,
    hostId,
  }),
}));

vi.mock("@/hooks/worktree/use-worktree-list-by-workspace-paths-query", () => ({
  useWorktreeListByWorkspacePathsForClient: () => ({
    data: nativeScopeWorktreeMocks.loaded
      ? { workspaces: nativeScopeWorktreeMocks.workspaces }
      : undefined,
    isPending: nativeScopeWorktreeMocks.pending,
  }),
}));

vi.mock("@/hooks/providers/use-providers-skills-list-query", () => ({
  useProvidersSkillsList: (args: {
    providerId: string;
    scope: string;
    workspaceRoot: string | null;
    enabled: boolean;
  }) => {
    skillMocks.listCalls.push(args);
    if (!args.enabled) {
      return {
        data: undefined,
        isLoading: false,
        isPending: false,
        isError: false,
        error: null,
      };
    }
    return {
      data: { skills: skillMocks.skills },
      isLoading: false,
      isPending: false,
      isError: false,
      error: null,
    };
  },
}));

vi.mock("@/hooks/providers/use-providers-skills-mutate-mutation", () => ({
  useProvidersSkillsMutate: () => ({
    mutate: (
      variables: {
        providerId: string;
        scope: ProviderNativeScope;
        workspaceRoot: string | null;
        mutation: ProvidersSkillsMutateAction;
        suppressToast: boolean;
      },
      opts: {
        onSuccess: () => void;
        onError: (err: { message: string }) => void;
      },
    ) => {
      skillMocks.mutateCalls.push(variables);
      skillMocks.mutate(variables, opts);
    },
    mutateAsync: (variables: {
      providerId: string;
      scope: ProviderNativeScope;
      workspaceRoot: string | null;
      mutation: ProvidersSkillsMutateAction;
      suppressToast: boolean;
    }) => {
      skillMocks.mutateCalls.push(variables);
      skillMocks.mutate(variables);
      return Promise.resolve({
        kind: "skills" as const,
        skills: skillMocks.skills,
      });
    },
    isPending: skillMocks.mutateIsPending,
  }),
}));

vi.mock("@/hooks/workspace/use-read-file-query", () => ({
  useWorkspaceReadFile: (
    _client: unknown,
    _workspacePath: string | null,
    _filePath: string | null,
    _cacheKeyIdentity: ReadonlyArray<unknown> | undefined,
  ) => ({
    data: {
      content: '---\nname: find-skills\ndescription: "Helps"\n---\n\n# Body\n',
      truncated: false,
      error: null,
    },
    isPending: false,
    isError: false,
    error: null,
  }),
}));

const BOTH: readonly ProviderNativeScope[] = ["global", "project"];

const FIND_SKILLS: ProviderSkill = {
  name: "find-skills",
  description: "Helps users discover and install agent skills.",
  path: "/Users/dev/.agents/skills/find-skills",
  source: "shared",
};

function skillsState(): ProviderCliState {
  return {
    providerId: "codex",
    enabled: true,
    disabledBy: null,
    nativeCapabilities: {
      supportedTabs: ["skills"],
      mcp: null,
      plugins: null,
      skills: {
        actionScopes: {
          list: [...skillMocks.listScopes],
          add: [],
          create: [...skillMocks.createScopes],
          import: [...skillMocks.importScopes],
          remove: [...skillMocks.removeScopes],
        },
      },
      modelProviders: null,
    },
    selected: { kind: "bundled" },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
  };
}

function seedWorkspace(): void {
  useWorkspaceFoldersStore.setState({
    folders: ["/Users/dev/app"],
    folderInfoByPath: {
      "/Users/dev/app": {
        path: "/Users/dev/app",
        name: "app",
        repoIdentifier: null,
        hostId: "host-1",
      },
    },
  });
  nativeScopeResolvedWorkspaceMocks.folders = [
    { kind: "local-only", path: "/Users/dev/app", name: "app" },
  ];
  useProvidersWorkspaceSelectionStore.setState({
    selectedByHostId: {},
  });
}

function scopeTrigger(): HTMLElement {
  return screen.getByRole("button", { name: /^Skills location/ });
}

function chooseScopeOption(name: RegExp): void {
  fireEvent.click(scopeTrigger());
  fireEvent.click(screen.getByRole("option", { name }));
}

function confirmRemove(): void {
  fireEvent.click(
    within(screen.getByTestId("confirm-destructive-dialog")).getByRole(
      "button",
      { name: "Remove" },
    ),
  );
}

describe("<ProviderSkillsTab /> scope (F5)", () => {
  beforeEach(() => {
    skillMocks.skills = [FIND_SKILLS];
    skillMocks.listCalls = [];
    skillMocks.mutate.mockReset();
    skillMocks.mutateCalls = [];
    skillMocks.mutateIsPending = false;
    skillMocks.listScopes = [...BOTH];
    skillMocks.removeScopes = [...BOTH];
    skillMocks.createScopes = [];
    skillMocks.importScopes = [];
    resetNativeScopeTestMocks();
    seedWorkspace();
  });

  afterEach(() => {
    cleanup();
  });

  it("lists with global scope and null workspaceRoot by default", () => {
    render(<ProviderSkillsTab state={skillsState()} />);

    const globalCall = skillMocks.listCalls.find(
      (c) => c.scope === "global" && c.enabled,
    );
    expect(globalCall).toBeDefined();
    expect(globalCall?.workspaceRoot).toBeNull();
    expect(globalCall?.providerId).toBe("codex");
    expect(
      screen.getByRole("button", { name: /Open find-skills/ }),
    ).toBeDefined();
  });

  it("labels the scope picker Skills location (not MCP or Plugins)", () => {
    render(<ProviderSkillsTab state={skillsState()} />);

    expect(scopeTrigger().getAttribute("aria-label")).toMatch(
      /^Skills location:/,
    );
    expect(
      screen.queryByRole("button", { name: /^MCP config location/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Plugins location/ }),
    ).toBeNull();
  });

  it("switches to project scope and stamps workspaceRoot on list", () => {
    render(<ProviderSkillsTab state={skillsState()} />);

    chooseScopeOption(/app/);

    const projectCall = skillMocks.listCalls.find(
      (c) =>
        c.scope === "project" &&
        c.enabled &&
        c.workspaceRoot === "/Users/dev/app",
    );
    expect(projectCall).toBeDefined();
    expect(scopeTrigger().textContent).toContain("app");
  });

  it("carries the selected project scope on remove mutate", () => {
    render(<ProviderSkillsTab state={skillsState()} />);

    chooseScopeOption(/app/);
    fireEvent.click(screen.getByRole("button", { name: /Open find-skills/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    confirmRemove();

    expect(skillMocks.mutateCalls).toEqual([
      {
        providerId: "codex",
        scope: "project",
        workspaceRoot: "/Users/dev/app",
        mutation: {
          action: "remove",
          name: FIND_SKILLS.name,
          path: FIND_SKILLS.path,
        },
        suppressToast: true,
      },
    ]);
  });

  it("shows project-needs-workspace empty state when project has no root", () => {
    useWorkspaceFoldersStore.setState({
      folders: [],
      folderInfoByPath: {},
    });
    nativeScopeResolvedWorkspaceMocks.folders = [];
    useProvidersWorkspaceSelectionStore.setState({
      selectedByHostId: {},
    });
    skillMocks.listScopes = ["project"];
    skillMocks.removeScopes = ["project"];
    skillMocks.skills = [];

    render(<ProviderSkillsTab state={skillsState()} />);

    expect(screen.getByText("Select a workspace")).toBeDefined();
    expect(
      screen.getByText(
        "Choose a project workspace above to manage project-scoped skills on this host.",
      ),
    ).toBeDefined();
    expect(skillMocks.listCalls.every((c) => !c.enabled)).toBe(true);
  });

  it("hides Add skill when only project create is advertised while viewing Global", () => {
    // Per-scope authoring gate: project-only create must not appear on Global.
    // Distinct from composer's providerScoped "Available to" control.
    skillMocks.createScopes = ["project"];
    skillMocks.importScopes = [];
    skillMocks.skills = [FIND_SKILLS];
    render(<ProviderSkillsTab state={skillsState()} />);

    expect(screen.queryByRole("button", { name: /Add skill/ })).toBeNull();

    chooseScopeOption(/app/);
    expect(screen.getByRole("button", { name: /Add skill/ })).toBeDefined();
  });

  it("shows Available to at project with no provider-sourced rows, and hides it when the scope is not advertised", () => {
    skillMocks.createScopes = ["project"];
    skillMocks.importScopes = ["project"];
    skillMocks.skills = [FIND_SKILLS];
    render(<ProviderSkillsTab state={skillsState()} />);

    expect(screen.queryByRole("button", { name: /Add skill/ })).toBeNull();
    expect(screen.queryByText("Available to")).toBeNull();
    expect(screen.queryByLabelText(/Codex only/)).toBeNull();

    chooseScopeOption(/app/);
    fireEvent.click(screen.getByRole("button", { name: /Add skill/ }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Available to");
    expect(screen.getByLabelText(/Codex only/)).toBeDefined();
    expect(screen.getByLabelText(/Every provider/)).toBeDefined();
    expect(screen.getByText("~/.agents/skills")).toBeDefined();

    fireEvent.click(screen.getByLabelText(/Codex only/));
    expect(screen.getByText("Codex's own skills folder")).toBeDefined();
    expect(screen.queryByText(/\.codex\/skills/)).toBeNull();
  });

  it("does not present the scope picker as an Available-to / providerScoped control", () => {
    // Guard against conflating global/project location with the composer's
    // shared-vs-provider "Available to" axis. Asserted before the composer
    // opens: Radix aria-hides the background, and accessible names inside
    // visibility:hidden subtrees collapse to "".
    skillMocks.createScopes = ["global"];
    skillMocks.skills = [FIND_SKILLS];
    render(<ProviderSkillsTab state={skillsState()} />);

    const location = scopeTrigger();
    expect(location.getAttribute("aria-label")).toMatch(/^Skills location:/);
    expect(location.textContent).not.toMatch(/Available to/i);
    expect(location.textContent).not.toMatch(/providerScoped/i);

    fireEvent.click(screen.getByRole("button", { name: /Add skill/ }));
    // Composer is a separate surface; its "Available to" copy must not appear
    // as a second location picker label on the dialog title/description.
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-label") ?? "").not.toMatch(
      /Skills location/i,
    );
    expect(dialog.textContent).not.toMatch(/Skills location/i);
  });
});
