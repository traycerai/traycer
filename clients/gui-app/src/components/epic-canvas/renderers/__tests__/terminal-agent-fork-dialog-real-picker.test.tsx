import type { KeyboardEvent, Key, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";

// Real Radix DropdownMenu opens on pointerdown; swap only the low-level
// primitive so the REAL ProfileDropdown / HarnessModelPicker admission wiring
// still runs. Mirrors harness-model-picker.test.tsx.
vi.mock("@/components/ui/dropdown-menu", () => {
  const passthrough = (props: { readonly children: ReactNode }): ReactNode =>
    props.children;
  return {
    DropdownMenu: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: (props: {
      readonly children: ReactNode;
      readonly container: HTMLElement | null | undefined;
      readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
    }): ReactNode => (
      <div
        role="menu"
        tabIndex={-1}
        data-testid="profile-dropdown-content"
        data-has-container={props.container instanceof HTMLElement}
        onKeyDown={props.onKeyDown}
      >
        {props.children}
      </div>
    ),
    DropdownMenuItem: (props: {
      readonly children: ReactNode;
      readonly onSelect: (() => void) | undefined;
      readonly "aria-label": string | undefined;
      readonly "aria-current": "true" | undefined;
      readonly className: string | undefined;
      readonly disabled: boolean | undefined;
      readonly title: string | undefined;
    }): ReactNode => (
      <button
        type="button"
        role="menuitem"
        aria-label={props["aria-label"]}
        aria-current={props["aria-current"]}
        className={props.className}
        disabled={props.disabled}
        title={props.title}
        onClick={props.disabled === true ? undefined : props.onSelect}
      >
        {props.children}
      </button>
    ),
    DropdownMenuSeparator: (): ReactNode => <div role="separator" />,
    DropdownMenuShortcut: (props: {
      readonly children: ReactNode;
      readonly "data-testid": string | undefined;
    }): ReactNode => (
      <span data-testid={props["data-testid"]}>{props.children}</span>
    ),
  };
});

const dialogMocks = vi.hoisted(() => ({
  create: vi.fn<(input: unknown) => Promise<string | null>>(),
  mutateAsync: vi.fn().mockResolvedValue({ verdicts: [] }),
  forkProfileSupported: true,
  providerStates: [] as ProviderCliState[],
}));

vi.mock("@/hooks/agent/use-create-tui-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/agent/use-create-tui-agent")>();
  return {
    ...actual,
    useCreateTuiAgentForClient: () => ({
      create: dialogMocks.create,
      isPending: false,
    }),
  };
});

vi.mock("@/hooks/agent/use-validate-tui-fork-profile-mutation", () => ({
  useValidateTuiForkProfile: () => ({
    mutateAsync: dialogMocks.mutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/hooks/agent/use-tui-fork-profile-support", () => ({
  useTuiForkProfileSupported: () => dialogMocks.forkProfileSupported,
}));

vi.mock("sonner", () => ({
  toast: vi.fn(),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: vi.fn(),
    openHistory: vi.fn(),
    close: vi.fn(),
    setSection: vi.fn(),
  }),
}));

vi.mock("@/hooks/rate-limits/use-profile-usage-comparison", () => ({
  useProfileUsageComparison: (args: {
    readonly runTargetHostId: string | null;
  }) => ({
    hostId: args.runTargetHostId,
    isReady: true,
    entries: new Map(),
  }),
}));

vi.mock("@/hooks/providers/use-providers-ensure-pack-mutation", () => ({
  useProvidersEnsurePackForClient: () => ({
    mutate: vi.fn(),
  }),
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: (activity: {
    readonly enabled: boolean;
    readonly subscribed: boolean;
  }) => ({
    data: activity.enabled
      ? { providers: dialogMocks.providerStates }
      : undefined,
    isPending: false,
    isError: false,
    isFetching: false,
  }),
  useProvidersListForClient: (
    _client: unknown,
    activity: { readonly enabled: boolean; readonly subscribed: boolean },
  ) => ({
    data: activity.enabled
      ? { providers: dialogMocks.providerStates }
      : undefined,
    isPending: false,
    isError: false,
    isFetching: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-set-profile-enabled-mutation", () => ({
  useProviderProfileEnablementPending: () => () => false,
  useProvidersSetProfileEnabledForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

// useResolvedSeededProfileId still hits useHostQuery directly (not the
// providers-list-query wrapper). Mirror the same provider list so a managed
// seed is not tombstoned to ambient mid-test.
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: {
    readonly options: { readonly enabled: boolean } | null;
  }) => {
    if (!(args.options?.enabled ?? false)) return { data: undefined };
    return { data: { providers: dialogMocks.providerStates } };
  },
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => hostId ?? "default",
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-test",
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "host-test",
        kind: "local",
        label: "Test host",
        transportDialability: "dialable",
        websocketUrl: "ws://127.0.0.1:0",
      },
    ],
  }),
}));

vi.mock("react-virtuoso", async () => {
  const React = await import("react");

  interface MockVirtuosoHandle {
    readonly scrollIntoView: (location: unknown) => void;
    readonly scrollToIndex: (location: unknown) => void;
    readonly scrollBy: (location: unknown) => void;
    readonly scrollTo: (location: unknown) => void;
    readonly autoscrollToBottom: () => void;
    readonly getState: (callback: (state: null) => void) => void;
  }

  interface MockVirtuosoProps {
    readonly id?: string;
    readonly role?: string;
    readonly "aria-label"?: string;
    readonly className?: string;
    readonly data?: ReadonlyArray<unknown>;
    readonly totalCount?: number;
    readonly computeItemKey?: (index: number, item: undefined) => Key;
    readonly initialTopMostItemIndex?:
      | number
      | { readonly index: number | "LAST" };
    readonly itemContent?: (index: number, item: undefined) => ReactNode;
  }

  const Virtuoso = React.forwardRef<MockVirtuosoHandle, MockVirtuosoProps>(
    (props, ref) => {
      React.useImperativeHandle(ref, () => ({
        autoscrollToBottom: () => undefined,
        getState: (callback) => {
          callback(null);
        },
        scrollBy: () => undefined,
        scrollIntoView: () => undefined,
        scrollTo: () => undefined,
        scrollToIndex: () => undefined,
      }));

      const totalCount = props.totalCount ?? props.data?.length ?? 0;
      const children = Array.from({ length: totalCount }, (_unused, index) =>
        React.createElement(
          React.Fragment,
          { key: props.computeItemKey?.(index, undefined) ?? index },
          props.itemContent?.(index, undefined),
        ),
      );

      return React.createElement(
        "div",
        {
          id: props.id,
          role: props.role,
          "aria-label": props["aria-label"],
          className: props.className,
          "data-testid": "virtuoso-scroller",
        },
        ...children,
      );
    },
  );

  return { Virtuoso };
});

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  harnessCatalogEntryNeedsRefresh: () => true,
  useGuiHarnessesQueryForClient: () => ({
    data: {
      harnesses: [
        {
          id: "claude",
          label: "Claude Code",
          enabled: true,
          available: true,
          error: null,
          modes: ["gui", "tui"],
          requiresApiKey: false,
          supportedPermissionModes: ["supervised"],
          availabilityPending: false,
        },
      ],
    },
    isPending: false,
    error: null,
  }),
  useGuiHarnessModelsQueryForClient: () => ({
    data: {
      harnessId: "claude",
      models: [
        {
          harnessId: "claude",
          slug: "claude-opus-4-7",
          label: "Claude Opus",
          description: null,
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: null,
          supportedReasoningEfforts: [],
          defaultServiceTier: null,
          supportedServiceTiers: [],
          deprecationNotice: null,
          metadata: {},
        },
      ],
    },
    isPending: false,
    error: null,
    refetch: () => Promise.resolve({ data: undefined }),
  }),
  useGuiHarnessCommandsQuery: () => ({
    data: { harnessId: "claude", commands: [] },
    isPending: false,
    error: null,
    refetch: () => Promise.resolve({ data: undefined }),
  }),
  useGuiHarnessCatalogForClient: () => ({
    harnesses: [
      {
        id: "claude",
        label: "Claude Code",
        enabled: true,
        available: true,
        error: null,
        modes: ["gui", "tui"],
        requiresApiKey: false,
        supportedPermissionModes: ["supervised"],
        availabilityPending: false,
        models: [
          {
            harnessId: "claude",
            slug: "claude-opus-4-7",
            label: "Claude Opus",
            description: null,
            contextWindow: null,
            maxOutputTokens: null,
            defaultReasoningEffort: null,
            supportedReasoningEfforts: [],
            defaultServiceTier: null,
            supportedServiceTiers: [],
            deprecationNotice: null,
            metadata: {},
          },
        ],
        modelsLoading: false,
        modelsError: null,
      },
    ],
    harnessesLoading: false,
    harnessesError: null,
    modelsLoading: false,
  }),
  useRefreshHarnessCatalogForClient: () => async () => {},
}));

vi.mock("@/components/home/pickers/agent-mode-toggle", () => ({
  AgentModeToggle: () => (
    <button type="button" aria-label="Agent mode">
      Regular
    </button>
  ),
}));

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    ActiveHostWorkspaceControls: () => null,
  }),
);

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { TuiAgentProjection } from "@/stores/epics/open-epic/types";
import type { ForkWorkspaceSeed } from "@/lib/worktree/fork-workspace-seed";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import { useSeededWorkspaceSnapshotStore } from "@/stores/worktree/seeded-workspace-snapshot-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TerminalAgentForkDialog } from "../terminal-agent-fork-dialog";

const CAPABILITY_LOCK_REASON =
  "Update Traycer host to continue this session under another profile.";
const WORK_REJECTION_REASON = "some reason";
// Host bulk preflight message shape for fork-before-first-turn (SOURCE_NOT_READY).
// The dialog surfaces `verdict.message` on the row verbatim - not the client
// submit-time copy in tui-fork-profile-rejection.ts.
const SOURCE_NOT_READY_REASON =
  "SOURCE_NOT_READY: terminal agent session 'source-session' has no conversation yet - send it a message before forking.";

describe("<TerminalAgentForkDialog /> real HarnessModelPicker rows", () => {
  afterEach(() => {
    dialogMocks.create.mockReset();
    dialogMocks.mutateAsync.mockReset();
    dialogMocks.mutateAsync.mockResolvedValue({ verdicts: [] });
    dialogMocks.forkProfileSupported = true;
    dialogMocks.providerStates = [];
    useWorktreeIntentStagingStore.getState().resetForTests();
    useSeededWorkspaceSnapshotStore.getState().resetForTests();
    cleanup();
  });

  it("autofocuses the real picker control without emphasizing the whole section", async () => {
    seedClaudeProviders([ambientProfile("Terminal account")]);

    renderDialog({ intent: "continue", sourceAgent: sourceAgent() });

    const picker = screen.getByRole("button", { name: /Claude Opus/ });
    await waitFor(() => {
      expect(document.activeElement).toBe(picker);
    });
    expect(document.activeElement).not.toBe(
      screen.getByTestId("terminal-fork-profile-section"),
    );
  });

  it("disables real ProfileDropdown rows from bulk fork-admission verdicts (continue, capable host)", async () => {
    seedClaudeProviders([
      ambientProfile("Terminal account"),
      managedProfile("work-profile", "Work"),
    ]);
    dialogMocks.mutateAsync.mockResolvedValue({
      verdicts: [
        { targetProfileId: null, admitted: true, message: null },
        {
          targetProfileId: "work-profile",
          admitted: false,
          message: WORK_REJECTION_REASON,
        },
      ],
    });

    renderDialog({ intent: "continue", sourceAgent: sourceAgent() });

    await openPicker();
    await waitFor(() => {
      expect(dialogMocks.mutateAsync).toHaveBeenCalled();
    });

    // Mutation resolves on a microtask; wait until the rejected row carries
    // the server reason (not the pending "Checking…" lock).
    const rejected = await waitFor(() => {
      const row = screen.getByRole("menuitem", {
        name: new RegExp(`Work.*${escapeRegExp(WORK_REJECTION_REASON)}`),
      });
      if (!(row instanceof HTMLButtonElement)) {
        throw new Error("expected Work menuitem button");
      }
      return row;
    });

    expect(rejected.disabled).toBe(true);
    expect(rejected.getAttribute("aria-label")).toContain(
      WORK_REJECTION_REASON,
    );

    const titleBefore = titleInputValue();
    fireEvent.click(rejected);
    expect(titleInputValue()).toBe(titleBefore);
    expect(titleInputValue()).toBe("Fork - Source terminal");

    const admitted = screen.getByRole("menuitem", {
      name: /Terminal account/,
    });
    if (!(admitted instanceof HTMLButtonElement)) {
      throw new Error("expected ambient menuitem button");
    }
    expect(admitted.disabled).toBe(false);
    expect(admitted.getAttribute("aria-label") ?? "").not.toContain(
      WORK_REJECTION_REASON,
    );
    // Admitted ambient stays clickable (same-profile reselect is a no-op).
    fireEvent.click(admitted);
    expect(titleInputValue()).toBe("Fork - Source terminal");
  });

  it("disables every real ProfileDropdown row (including the source's own) when bulk verdicts are all SOURCE_NOT_READY", async () => {
    // Fork-before-first-turn: the host rejects every candidate - including a
    // same-profile plain continue under the source itself - because Claude has
    // not yet written the source session transcript. Prove the continue-mode
    // picker surfaces that on every row (not just non-source targets).
    seedClaudeProviders([
      ambientProfile("Terminal account"),
      managedProfile("work-profile", "Work"),
    ]);
    dialogMocks.mutateAsync.mockResolvedValue({
      verdicts: [
        {
          targetProfileId: null,
          admitted: false,
          subcode: "SOURCE_NOT_READY",
          message: SOURCE_NOT_READY_REASON,
        },
        {
          targetProfileId: "work-profile",
          admitted: false,
          subcode: "SOURCE_NOT_READY",
          message: SOURCE_NOT_READY_REASON,
        },
      ],
    });

    renderDialog({ intent: "continue", sourceAgent: sourceAgent() });

    await openPicker();
    await waitFor(() => {
      expect(dialogMocks.mutateAsync).toHaveBeenCalled();
    });

    const sourceRow = await waitFor(() => {
      const row = screen.getByRole("menuitem", {
        name: new RegExp(
          `Terminal account.*${escapeRegExp(SOURCE_NOT_READY_REASON)}`,
        ),
      });
      if (!(row instanceof HTMLButtonElement)) {
        throw new Error("expected ambient menuitem button");
      }
      return row;
    });
    expect(sourceRow.disabled).toBe(true);
    expect(sourceRow.getAttribute("aria-label")).toContain(
      SOURCE_NOT_READY_REASON,
    );

    const workRow = screen.getByRole("menuitem", {
      name: new RegExp(`Work.*${escapeRegExp(SOURCE_NOT_READY_REASON)}`),
    });
    if (!(workRow instanceof HTMLButtonElement)) {
      throw new Error("expected Work menuitem button");
    }
    expect(workRow.disabled).toBe(true);
    expect(workRow.getAttribute("aria-label")).toContain(
      SOURCE_NOT_READY_REASON,
    );
    const continueButton = screen.getByRole("button", { name: "Continue" });
    if (!(continueButton instanceof HTMLButtonElement)) {
      throw new Error("expected Continue button");
    }
    expect(continueButton.disabled).toBe(true);

    // Disabled rows are non-interactive - click must not change the title.
    const titleBefore = titleInputValue();
    fireEvent.click(sourceRow);
    fireEvent.click(workRow);
    expect(titleInputValue()).toBe(titleBefore);
  });

  it("locks non-source real ProfileDropdown rows under capability-false plain fork intent", async () => {
    dialogMocks.forkProfileSupported = false;
    seedClaudeProviders([
      ambientProfile("Terminal account"),
      managedProfile("work-profile", "Work"),
    ]);

    renderDialog({ intent: "fork", sourceAgent: sourceAgent() });

    await openPicker();

    const locked = await waitFor(() => {
      const row = screen.getByRole("menuitem", {
        name: new RegExp(`Work.*${escapeRegExp(CAPABILITY_LOCK_REASON)}`),
      });
      if (!(row instanceof HTMLButtonElement)) {
        throw new Error("expected Work menuitem button");
      }
      return row;
    });

    expect(locked.disabled).toBe(true);
    expect(locked.getAttribute("aria-label")).toContain(CAPABILITY_LOCK_REASON);

    const titleBefore = titleInputValue();
    fireEvent.click(locked);
    expect(titleInputValue()).toBe(titleBefore);
    expect(titleInputValue()).toBe("Fork - Source terminal");

    const sourceRow = screen.getByRole("menuitem", {
      name: /Terminal account/,
    });
    if (!(sourceRow instanceof HTMLButtonElement)) {
      throw new Error("expected ambient menuitem button");
    }
    expect(sourceRow.disabled).toBe(false);
    expect(sourceRow.getAttribute("aria-label") ?? "").not.toContain(
      CAPABILITY_LOCK_REASON,
    );
  });
});

function renderDialog(input: {
  readonly intent: "fork" | "continue";
  readonly sourceAgent: TuiAgentProjection;
}): void {
  render(
    <TooltipProvider delayDuration={0}>
      <TerminalAgentForkDialog
        open
        target={{
          sourceAgent: input.sourceAgent,
          workspaceSeed: emptyWorkspaceSeed(),
          intent: input.intent,
        }}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={null}
        onOpenChange={() => undefined}
      />
    </TooltipProvider>,
  );
}

async function openPicker(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /Claude Opus/ }));
  await screen.findByRole("textbox", { name: /^Search/ });
  await screen.findByTestId("profile-dropdown-content");
}

function titleInputValue(): string {
  const input = screen.getByRole("textbox", {
    name: /^(Fork terminal agent title|Continue under another profile title)$/,
  });
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("expected title input");
  }
  return input.value;
}

function sourceAgent(): TuiAgentProjection {
  return {
    id: "source-agent",
    harnessId: "claude",
    title: "Source terminal",
    parentId: "source-parent",
    createdAt: 0,
    updatedAt: 0,
    userId: "user-test",
    hostId: "host-test",
    workspaceFolders: ["/workspace"],
    workspaceMode: undefined,
    model: "claude-opus-4-7",
    reasoningEffort: "high",
    agentMode: "regular",
    profileId: null,
    archivedAt: null,
    harnessSessionId: "source-session",
    terminalAgentArgs: null,
    terminalShellCommand: "claude",
    terminalShellArgs: ["--resume", "source-session"],
  };
}

function emptyWorkspaceSeed(): ForkWorkspaceSeed {
  return {
    workspace: { folders: [], folderInfoByPath: {}, primaryPath: null },
    intent: null,
  };
}

function ambientProfile(label: string): ProviderProfile {
  return {
    profileId: "ambient",
    enabled: true,
    kind: "ambient",
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

function managedProfile(profileId: string, label: string): ProviderProfile {
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

function seedClaudeProviders(profiles: ReadonlyArray<ProviderProfile>): void {
  dialogMocks.providerStates = [
    {
      providerId: "claude-code",
      auth: {
        status: "authenticated",
        badgeText: null,
        label: null,
        detail: null,
      },
      enabled: true,
      disabledBy: null,
      selected: { kind: "bundled" },
      candidates: [],
      authPending: false,
      checkedAt: null,
      apiKey: { supported: false, configured: false, source: null },
      terminalAgentArgs: "",
      envOverrides: [],
      loginCapability: {
        oauthArgs: ["auth", "login"],
        token: null,
        codePaste: null,
        terminalLogin: null,
      },
      availabilityPending: false,
      nativeCapabilities: {
        supportedTabs: ["general", "env", "usage"],
        mcp: null,
        plugins: null,
        skills: null,
        modelProviders: null,
      },
      managedInstallState: null,
      versionVisibility: null,
      advisory: null,
      profiles: [...profiles],
    },
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
