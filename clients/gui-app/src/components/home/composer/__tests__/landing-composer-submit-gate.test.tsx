import {
  act,
  cleanup,
  fireEvent,
  render as renderComponent,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ComposerBodyProps } from "@/components/home/composer/composer-body";
import type { TerminalAgentLaunch } from "@/components/home/hooks/use-landing-composer-actions";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import { LandingComposer } from "../landing-composer";
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";

const DIRTY_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "dirty" }] }],
};

const testState = vi.hoisted(() => ({
  submit: vi.fn(),
  selectTerminalAgent: vi.fn<(launch: TerminalAgentLaunch) => null>(() => null),
  bodySubmit: null as (() => void) | null,
  startTerminal: null as ComposerBodyProps["onStartTerminal"] | null,
  installEditor: null as (() => void) | null,
  snapshot: null as (() => void) | null,
  ingesting: false,
  createPending: false,
  pasteDisabled: false,
  resolvingPaths: false,
  /** Captures the real-ish pending job runner used by in-place landing paste. */
  runPendingImageJob: null as
    | ((job: (signal: AbortSignal) => Promise<void>) => void)
    | null,
  /** The selected model; empty for a person whose host offers no catalog. */
  modelSlug: "claude-sonnet",
  /** The resolved host's catalog: `null` until it answers. */
  catalogHostId: null as string | null,
  /** Whether the current host's workspace can start a send. */
  workspaceReady: true,
  /** Whether the current host's selected profile is ineligible. */
  profileDisabled: false,
  /** Whether the current host's provider pack is still downloading. */
  packBlocked: false,
  /** The resolved host's `providers.list`, `undefined` until it answers. */
  providers: undefined as
    | ReadonlyArray<{
        readonly providerId: string;
        readonly profiles: [];
        readonly managedInstallState: {
          readonly status: "downloading";
          readonly percent: number;
        } | null;
        readonly availabilityPending: boolean;
        readonly candidates: [];
      }>
    | undefined,
  providerListeners: new Set<() => void>(),
  toolbarStore: null as { readonly setState: (patch: object) => void } | null,
}));

/** The new host's Claude Code row: no profiles, no binary but its pack. */
function claudeCodeProvider(
  managedInstallState: {
    readonly status: "downloading";
    readonly percent: number;
  } | null,
): NonNullable<(typeof testState)["providers"]>[number] {
  return {
    providerId: "claude-code",
    profiles: [],
    managedInstallState,
    availabilityPending: false,
    candidates: [],
  };
}

vi.mock("@/components/home/composer/composer-body", async () => {
  const React = await import("react");
  return {
    ComposerBody: (props: ComposerBodyProps) => {
      testState.bodySubmit = props.onSubmit;
      testState.startTerminal = props.onStartTerminal;
      testState.installEditor = () => {
        props.editorRef.current = editorHandle();
      };
      testState.snapshot = () => {
        props.onDocumentChange(DIRTY_CONTENT, { from: 1, to: 1 });
      };
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          {
            type: "button",
            disabled: props.isSubmitting,
            onClick: props.onSubmit,
          },
          "Submit landing",
        ),
        props.workspaceControls,
      );
    },
  };
});

vi.mock("@/stores/settings/settings-store", () => {
  const state = { composerMode: "chat", setComposerMode: vi.fn() };
  return {
    useSettingsStore: (selector: (value: typeof state) => unknown) =>
      selector(state),
  };
});

vi.mock("@/stores/home/landing-draft-store", () => {
  const state = {
    drafts: [],
    setDraftComposerMode: vi.fn(),
    setDraftSettings: vi.fn(),
    createDraft: vi.fn(() => "draft-for-test"),
    // handleSnapshot's unbound-create branch now calls createDraftWithId
    // (reusing a pre-minted pendingCreateId when present) rather than
    // createDraft directly.
    createDraftWithId: vi.fn(() => "draft-for-test"),
    restoreDraftWorkspaceForHost: vi.fn(),
    setDraftContent: vi.fn(),
  };
  const useLandingDraftStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  );
  return {
    useLandingDraftStore,
  };
});

vi.mock("@/stores/composer/composer-run-settings-store", () => {
  const state = {
    globalLastRunSettingsByHostId: {},
    legacyGlobalLastRunSettings: null,
    setGlobalRunSettings: vi.fn(),
    // The imperative draft-mint path (`ensureSubmissionDraft`) seeds from
    // this; null preserves the suite's "no remembered last-run" premise.
    getGlobalRunSettings: () => null,
  };
  const useComposerRunSettingsStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  );
  return {
    useComposerRunSettingsStore,
    selectGlobalLastRunSettings: () => null,
  };
});

vi.mock("@/components/home/hooks/use-composer-toolbar-store", () => {
  const toolbarStore = createStore(() => ({
    selection: {
      harnessId: "claude",
      get modelSlug() {
        return testState.modelSlug;
      },
      profileId: null,
    },
    get catalog() {
      return testState.catalogHostId === null
        ? { hostId: null, harnesses: undefined, modelsLoaded: false }
        : {
            hostId: testState.catalogHostId,
            harnesses: [],
            modelsLoaded: true,
          };
    },
    permission: "supervised",
    reasoning: "medium",
    serviceTier: "",
    agentMode: "regular",
  }));
  testState.toolbarStore = toolbarStore;
  return { useComposerToolbarStore: () => toolbarStore };
});

vi.mock(
  "@/hooks/providers/use-providers-list-query",
  async (importOriginal) => {
    const React = await import("react");
    return {
      ...(await importOriginal<
        typeof import("@/hooks/providers/use-providers-list-query")
      >()),
      // Subscribed, as the query is: `answerProviders` re-renders its readers.
      useProvidersListForClient: () => {
        const providers = React.useSyncExternalStore(
          (listener) => {
            testState.providerListeners.add(listener);
            return () => {
              testState.providerListeners.delete(listener);
            };
          },
          () => testState.providers,
        );
        return {
          data: providers === undefined ? undefined : { providers },
          isError: false,
        };
      },
    };
  },
);

/** The new host's `providers.list` answers again. */
function answerProviders(
  providers: NonNullable<(typeof testState)["providers"]>,
): void {
  testState.providers = providers;
  for (const listener of testState.providerListeners) listener();
}

vi.mock("@/components/home/hooks/use-landing-composer-actions", () => ({
  useLandingComposerActions: () => ({
    submit: testState.submit,
    selectTerminalAgent: testState.selectTerminalAgent,
    // `isSubmitting` now reads `actions.isPending` (the real hook's
    // `createEpic.isPending || terminalAgentCreate.isPending`) rather than a
    // permanently-false placeholder - mirror `testState.createPending` here
    // too, the same flag the neighboring `useEpicCreateForClient` mock below
    // already drives, so this gate suite's "a create is in flight" setup
    // still reaches the composer now that it goes through this seam.
    isPending: testState.createPending,
    attachmentUpload: null,
  }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    fileDrops: {
      resolveDroppedFilePaths: () => Promise.resolve([]),
      copyDroppedFilePaths: (paths: readonly string[]) =>
        Promise.resolve(paths),
    },
  }),
}));

vi.mock("@/hooks/composer/use-landing-composer-paste", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/hooks/composer/use-landing-composer-paste")
    >();
  return {
    ...actual,
    useLandingComposerPaste: (params: { readonly disabled: boolean }) => {
      testState.pasteDisabled = params.disabled;
      // Mirror runPendingImageJob → isIngestingImages so submit gating covers
      // the in-place paste path (not the deleted attach-at-anchor path).
      const runPendingImageJob = (
        job: (signal: AbortSignal) => Promise<void>,
      ) => {
        testState.ingesting = true;
        const controller = new AbortController();
        void job(controller.signal).finally(() => {
          testState.ingesting = false;
        });
      };
      testState.runPendingImageJob = runPendingImageJob;
      return {
        onPaste: vi.fn(),
        onDrop: vi.fn(),
        onDragOver: vi.fn(),
        onDragEnter: vi.fn(),
        onDragLeave: vi.fn(),
        attachImageFiles: vi.fn(),
        runPendingImageJob,
        isDraggingFiles: false,
        dragOverlayVariant: null,
        isIngestingImages: testState.ingesting,
        isResolvingFilePaths: testState.resolvingPaths,
      };
    },
  };
});

vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => ({ folders: [], isLoading: false }),
}));

vi.mock("@/lib/composer/workspace-composer-availability", () => ({
  deriveFolderlessAllowedWorkspaceAvailability: () => ({
    disabledHint: null,
  }),
  workspaceComposerCanStart: () => testState.workspaceReady,
}));

vi.mock("@/components/home/composer/surface-activity-hooks", () => ({
  useSurfaceActivity: () => true,
}));
vi.mock("@/components/chat/composer/picker/use-composer-picker-items", () => ({
  useComposerPickerItems: () => undefined,
}));
vi.mock("@/hooks/composer/use-workspace-mention-roots", () => ({
  useLandingComposerMentionRoots: () => [],
}));
vi.mock("@/hooks/providers/use-provider-pack-gate", () => ({
  // Same treatment as `use-composer-dictation` above: a host-backed readiness
  // hook stubbed to its "nothing to report" answer so these gate tests stay
  // about the gate they name. `blocked: false` is also the hook's real
  // fail-open answer before `providers.list` resolves.
  useProviderPackGate: () => ({
    blocked: testState.packBlocked,
    hint: testState.packBlocked ? "Preparing Claude Code… 40%" : null,
    preparing: null,
  }),
  useProviderPackGateForClient: () => ({
    blocked: false,
    hint: null,
    preparing: null,
  }),
}));

vi.mock("@/components/chat/composer/use-profile-eligibility-gate", () => ({
  useProfileEligibilityGate: () => ({
    disabled: testState.profileDisabled,
    profileLabel: null,
    enablePending: false,
    enableProfile: vi.fn(),
  }),
}));

vi.mock("@/hooks/composer/use-composer-dictation", () => ({
  useComposerDictation: () => ({
    dictationControl: null,
    dictationPreparing: null,
  }),
}));
vi.mock("@/hooks/composer/use-landing-image-fetcher", () => ({
  useLandingImageFetcher: () => vi.fn(),
}));
// `useEpicCreateForClient`/`useCreateTuiAgentForClient` mocks used to live
// here, driven by `testState.createPending`. Before the isSubmitting change,
// `landing-composer.tsx` called `useEpicCreateForClient` itself and these
// mocks were reachable - that is what made "locks editor input... during a
// submission" pass for a reason production could never produce: the
// composer's own `isPending` observer was permanently false, so the mock was
// supplying the very behaviour the real code was incapable of. Now that
// `isSubmitting` reads `actions.isPending` through the (fully-stubbed)
// `useLandingComposerActions` mock above instead, nothing in the mounted
// tree reaches these two hooks - confirmed by removing them and finding the
// suite stays green. Left removed rather than kept as a second, unreachable
// copy of the same intent.
// P1.2: the composer resolves its placement (pin ?? effective) through this
// one hook. These suites are about paste/gating/banner behaviour, not
// selection derivation, so it is stubbed at that single boundary - the same
// treatment the other host-backed hooks above get.
vi.mock("@/hooks/host/use-composer-placement", () => ({
  useComposerPlacement: () => ({
    pin: {
      selection: null,
      setSelection: () => undefined,
      resolvedHostId: "host-test",
      isPinned: false,
      latchOnFirstUse: () => undefined,
    },
    target: {
      resolvedHostId: "host-test",
      client: null,
      hostLabel: "Local",
      isPinned: false,
      namedHostDead: false,
    },
    hostLabelFor: () => "Local",
  }),
}));

// The staged sandbox's send reads the account and the catalogue; this suite
// has no auth runtime.
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: null }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: null }),
}));

vi.mock(
  "@/hooks/host/use-composer-surface-host-pin",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/host/use-composer-surface-host-pin")
    >()),
    useComposerSurfaceHostKey: () => "landing:window-test",
  }),
);

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostClient: () => null,
  // The staged send's terminal launcher reads the new host's row.
  useHostDirectory: () => ({
    findById: () => null,
    onChange: () => ({ dispose: () => undefined }),
  }),
  // The SPINE, a separate export since redesign P2.1.
  useHostRuntimeClient: () => null,
}));
vi.mock(
  "@/components/chat/composer/use-profile-rate-limit-switch-prompt",
  () => ({
    useProfileRateLimitSwitchPrompt: () => ({
      kind: "hidden",
      dismiss: vi.fn(),
    }),
  }),
);
vi.mock("@/hooks/providers/use-refresh-providers-list-on-turn", () => ({
  useRefreshProvidersListOnTurn: () => undefined,
}));

// `useDraftAuthorityControl` no longer claims anything (the fork rule is a
// synchronous local re-key, no host RPC) - the Query client here is kept
// for the other host-RPC hooks `LandingComposer` still uses. Shadows RTL's
// `render` so each case below keeps reading as a plain render.
function render(ui: ReactElement): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderComponent(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

afterEach(() => {
  cleanup();
  useStagedSandboxStore.setState({ bySurface: {} });
  testState.submit.mockClear();
  testState.selectTerminalAgent.mockClear();
  testState.startTerminal = null;
  testState.bodySubmit = null;
  testState.installEditor = null;
  testState.snapshot = null;
  testState.ingesting = false;
  testState.createPending = false;
  testState.pasteDisabled = false;
  testState.resolvingPaths = false;
  testState.runPendingImageJob = null;
  testState.modelSlug = "claude-sonnet";
  testState.catalogHostId = null;
  testState.providers = undefined;
  testState.workspaceReady = true;
  testState.profileDisabled = false;
  testState.packBlocked = false;
});

describe("LandingComposer direct submit gate", () => {
  it("lets a staged sandbox take a terminal agent's Start instead of launching it here", () => {
    useStagedSandboxStore.getState().stage("landing:window-test", {
      kind: "new",
      configuration: { kind: "personal" },
      shape: {
        os: "linux",
        cpus: 2,
        memoryMb: 4096,
        diskMb: null,
        region: "us-east",
        idleMinutes: 30,
        destroyAfterRestingMinutes: null,
      },
      name: "",
      wakeString: null,
    });
    render(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );
    const start = testState.startTerminal;
    if (start === null) throw new Error("expected ComposerBody seam");

    const started = start(
      {
        harnessId: "claude",
        model: null,
        reasoningEffort: null,
        terminalAgentArgs: null,
        profileId: null,
      },
      "host-test",
    );

    expect(started).toBe(false);
    expect(testState.selectTerminalAgent).not.toHaveBeenCalled();
  });

  it("launches a staged Start on the new sandbox with what that host offers", () => {
    useStagedSandboxStore.getState().stage("landing:window-test", {
      kind: "new",
      configuration: { kind: "personal" },
      shape: {
        os: "linux",
        cpus: 2,
        memoryMb: 4096,
        diskMb: null,
        region: "us-east",
        idleMinutes: 30,
        destroyAfterRestingMinutes: null,
      },
      name: "",
      wakeString: null,
    });
    render(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );
    const start = testState.startTerminal;
    if (start === null) throw new Error("expected ComposerBody seam");
    // Put together on the old host: a model and a managed profile of its own.
    act(() => {
      start(
        {
          harnessId: "claude",
          model: "old-host-model",
          reasoningEffort: "high",
          terminalAgentArgs: "--resume",
          profileId: "old-host-profile",
        },
        "host-test",
      );
    });

    // The sandbox is up; its catalog and providers answer, without that profile.
    act(() => {
      testState.catalogHostId = "host-test";
      testState.providers = [claudeCodeProvider(null)];
      testState.toolbarStore?.setState({
        catalog: {
          hostId: "host-test",
          harnesses: [{ id: "claude", available: true, modes: ["gui", "tui"] }],
          modelsLoaded: true,
        },
      });
      useStagedSandboxStore.getState().report("landing:window-test", {
        phase: "handoff",
        createdHostId: "host-test",
      });
    });

    expect(testState.selectTerminalAgent).toHaveBeenCalledTimes(1);
    expect(testState.selectTerminalAgent.mock.calls[0][0]).toEqual({
      harnessId: "claude",
      model: "claude-sonnet",
      reasoningEffort: "medium",
      terminalAgentArgs: "--resume",
      profileId: null,
    });
  });

  it("waits for the new sandbox's agent pack before launching a staged Start there", () => {
    useStagedSandboxStore.getState().stage("landing:window-test", {
      kind: "new",
      configuration: { kind: "personal" },
      shape: {
        os: "linux",
        cpus: 2,
        memoryMb: 4096,
        diskMb: null,
        region: "us-east",
        idleMinutes: 30,
        destroyAfterRestingMinutes: null,
      },
      name: "",
      wakeString: null,
    });
    render(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );
    const start = testState.startTerminal;
    if (start === null) throw new Error("expected ComposerBody seam");
    act(() => {
      start(
        {
          harnessId: "claude",
          model: null,
          reasoningEffort: null,
          terminalAgentArgs: null,
          profileId: null,
        },
        "host-test",
      );
    });

    // The sandbox is up, but the agent it would run is still downloading.
    act(() => {
      testState.catalogHostId = "host-test";
      testState.providers = [
        claudeCodeProvider({ status: "downloading", percent: 40 }),
      ];
      testState.toolbarStore?.setState({
        catalog: {
          hostId: "host-test",
          harnesses: [{ id: "claude", available: true, modes: ["gui", "tui"] }],
          modelsLoaded: true,
        },
      });
      useStagedSandboxStore.getState().report("landing:window-test", {
        phase: "handoff",
        createdHostId: "host-test",
      });
    });
    expect(testState.selectTerminalAgent).not.toHaveBeenCalled();
    expect(
      useStagedSandboxStore.getState().bySurface["landing:window-test"]
        ?.failure,
    ).toBeNull();

    // The pack lands.
    act(() => {
      answerProviders([claudeCodeProvider(null)]);
    });

    expect(testState.selectTerminalAgent).toHaveBeenCalledTimes(1);
    expect(
      useStagedSandboxStore.getState().bySurface["landing:window-test"],
    ).toBeUndefined();
  });

  it.each([
    ["is unavailable", { available: false, modes: ["gui", "tui"] }],
    ["runs only in chat", { available: true, modes: ["gui"] }],
  ] as const)(
    "launches no staged Start on a sandbox whose only harness %s",
    (_label, harness) => {
      useStagedSandboxStore.getState().stage("landing:window-test", {
        kind: "new",
        configuration: { kind: "personal" },
        shape: {
          os: "linux",
          cpus: 2,
          memoryMb: 4096,
          diskMb: null,
          region: "us-east",
          idleMinutes: 30,
          destroyAfterRestingMinutes: null,
        },
        name: "",
        wakeString: null,
      });
      render(
        <LandingComposer
          draftId={null}
          pendingCreateId={null}
          initialSettings={null}
          workspaceControls={() => null}
        />,
      );
      const start = testState.startTerminal;
      if (start === null) throw new Error("expected ComposerBody seam");
      act(() => {
        start(
          {
            harnessId: "claude",
            model: null,
            reasoningEffort: null,
            terminalAgentArgs: null,
            profileId: null,
          },
          "host-test",
        );
      });

      act(() => {
        testState.catalogHostId = "host-test";
        testState.providers = [claudeCodeProvider(null)];
        // Set outright: an earlier `setState` copied the catalog getter's
        // value into the store, so it no longer reads `testState`.
        testState.toolbarStore?.setState({
          catalog: {
            hostId: "host-test",
            harnesses: [{ id: "claude", ...harness }],
            modelsLoaded: true,
          },
        });
        useStagedSandboxStore.getState().report("landing:window-test", {
          phase: "handoff",
          createdHostId: "host-test",
        });
      });

      // Nothing runs there: the line says the sandbox cannot run an agent.
      expect(testState.selectTerminalAgent).not.toHaveBeenCalled();
      expect(
        useStagedSandboxStore.getState().bySurface["landing:window-test"]
          ?.failure,
      ).toEqual({ kind: "no-provider" });
    },
  );

  it("lets a staged sandbox take a send though this host's workspace folder is unresolved", () => {
    // The sandbox starts empty: the chip reads Empty sandbox and the
    // workspace controls are hidden.
    testState.workspaceReady = false;
    useStagedSandboxStore.getState().stage("landing:window-test", {
      kind: "new",
      configuration: { kind: "personal" },
      shape: {
        os: "linux",
        cpus: 2,
        memoryMb: 4096,
        diskMb: null,
        region: "us-east",
        idleMinutes: 30,
        destroyAfterRestingMinutes: null,
      },
      name: "",
      wakeString: null,
    });
    const composer = (
      <LandingComposer
        draftId={null}
        pendingCreateId="pending-test"
        initialSettings={null}
        workspaceControls={() => null}
      />
    );
    const view = render(composer);
    const installEditor = testState.installEditor;
    if (installEditor === null) throw new Error("expected ComposerBody seam");
    installEditor();
    const snapshot = testState.snapshot;
    if (snapshot === null) throw new Error("expected snapshot seam");
    snapshot();
    view.rerender(composer);

    fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));

    // The intercept took the send: it recorded the sending draft.
    expect(testState.submit).not.toHaveBeenCalled();
    expect(
      useStagedSandboxStore.getState().bySurface["landing:window-test"]
        ?.ownerId,
    ).toBe("pending-test");
  });

  it.each([
    ["selected profile is ineligible", "profileDisabled"],
    ["provider pack is downloading", "packBlocked"],
  ] as const)(
    "lets a staged sandbox take a send though this host's %s",
    (_label, gate) => {
      testState[gate] = true;
      useStagedSandboxStore.getState().stage("landing:window-test", {
        kind: "new",
        configuration: { kind: "personal" },
        shape: {
          os: "linux",
          cpus: 2,
          memoryMb: 4096,
          diskMb: null,
          region: "us-east",
          idleMinutes: 30,
          destroyAfterRestingMinutes: null,
        },
        name: "",
        wakeString: null,
      });
      const composer = (
        <LandingComposer
          draftId={null}
          pendingCreateId="pending-test"
          initialSettings={null}
          workspaceControls={() => null}
        />
      );
      const view = render(composer);
      const installEditor = testState.installEditor;
      if (installEditor === null) throw new Error("expected ComposerBody seam");
      installEditor();
      const snapshot = testState.snapshot;
      if (snapshot === null) throw new Error("expected snapshot seam");
      snapshot();
      view.rerender(composer);

      fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));

      // The intercept took the send: it recorded the sending draft.
      expect(testState.submit).not.toHaveBeenCalled();
      expect(
        useStagedSandboxStore.getState().bySurface["landing:window-test"]
          ?.ownerId,
      ).toBe("pending-test");
    },
  );

  it("lets a staged sandbox take a terminal agent's Start though this host's workspace folder is unresolved", () => {
    testState.workspaceReady = false;
    useStagedSandboxStore.getState().stage("landing:window-test", {
      kind: "new",
      configuration: { kind: "personal" },
      shape: {
        os: "linux",
        cpus: 2,
        memoryMb: 4096,
        diskMb: null,
        region: "us-east",
        idleMinutes: 30,
        destroyAfterRestingMinutes: null,
      },
      name: "",
      wakeString: null,
    });
    render(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );
    const start = testState.startTerminal;
    if (start === null) throw new Error("expected ComposerBody seam");
    const launch: TerminalAgentLaunch = {
      harnessId: "claude",
      model: null,
      reasoningEffort: null,
      terminalAgentArgs: null,
      profileId: null,
    };

    act(() => {
      start(launch, "host-test");
    });

    // The stage took the Start and keeps it for the new host.
    expect(testState.selectTerminalAgent).not.toHaveBeenCalled();
    expect(
      useStagedSandboxStore.getState().bySurface["landing:window-test"]
        ?.terminalLaunch,
    ).toEqual(launch);
  });

  it("lets a staged sandbox take the send of a person with no model to pick yet", () => {
    testState.modelSlug = "";
    useStagedSandboxStore.getState().stage("landing:window-test", {
      kind: "new",
      configuration: { kind: "personal" },
      shape: {
        os: "linux",
        cpus: 2,
        memoryMb: 4096,
        diskMb: null,
        region: "us-east",
        idleMinutes: 30,
        destroyAfterRestingMinutes: null,
      },
      name: "",
      wakeString: null,
    });
    const composer = (
      <LandingComposer
        draftId={null}
        pendingCreateId="pending-test"
        initialSettings={null}
        workspaceControls={() => null}
      />
    );
    const view = render(composer);
    const installEditor = testState.installEditor;
    if (installEditor === null) throw new Error("expected ComposerBody seam");
    installEditor();
    const snapshot = testState.snapshot;
    if (snapshot === null) throw new Error("expected snapshot seam");
    snapshot();
    view.rerender(composer);

    fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));

    // The intercept took the send: it recorded the sending draft.
    expect(testState.submit).not.toHaveBeenCalled();
    expect(
      useStagedSandboxStore.getState().bySurface["landing:window-test"]
        ?.ownerId,
    ).toBe("pending-test");
  });

  it("locks editor input, paste ingestion, and workspace controls during a submission", () => {
    testState.createPending = true;
    render(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={(disabled) => (
          <button type="button" disabled={disabled}>
            Change workspace
          </button>
        )}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Submit landing" }),
    ).toHaveProperty("disabled", true);
    expect(testState.pasteDisabled).toBe(true);
    expect(
      screen.getByRole("button", { name: "Change workspace" }),
    ).toHaveProperty("disabled", true);
  });

  it("blocks the actual landing submit path while image ingestion is pending", () => {
    testState.ingesting = true;
    const view = render(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );
    const installEditor = testState.installEditor;
    if (installEditor === null) throw new Error("expected ComposerBody seam");
    installEditor();
    const snapshot = testState.snapshot;
    if (snapshot === null) throw new Error("expected snapshot seam");
    snapshot();

    fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));
    expect(testState.submit).not.toHaveBeenCalled();

    testState.ingesting = false;
    view.rerender(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));
    expect(testState.submit).toHaveBeenCalledTimes(1);
  });

  it("submits the draft handleSnapshot minted, not null, while props.draftId is still catching up", () => {
    // The real race: the first submittable edit mints an unbound draft inside
    // this component, but `props.draftId` only flips on the parent's next
    // render - so a type-then-Enter submits with the prop still `null`. If that
    // `null` reaches the action, `ensureSubmissionDraft` mints a SECOND draft
    // and the one already holding the user's content is stranded. Nothing
    // re-render carries a new `draftId`, so the prop is still `null` at submit
    // time exactly as it is in the app.
    const view = render(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );
    const installEditor = testState.installEditor;
    if (installEditor === null) throw new Error("expected ComposerBody seam");
    installEditor();
    const snapshot = testState.snapshot;
    if (snapshot === null) throw new Error("expected snapshot seam");
    snapshot();
    // Re-render so the composer observes the content it just snapshotted and
    // opens the submit gate - still with `draftId={null}`, which is the point.
    view.rerender(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));

    expect(testState.submit).toHaveBeenCalledTimes(1);
    expect(testState.submit.mock.calls[0][0]).toMatchObject({
      draftId: "draft-for-test",
    });
  });

  // Item 8: a live runPendingImageJob (landing in-place paste) holds submit closed
  // until the job settles, then clears.
  it("blocks submit while a runPendingImageJob is in flight and opens after it settles", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const view = render(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );
    const installEditor = testState.installEditor;
    if (installEditor === null) throw new Error("expected ComposerBody seam");
    installEditor();
    const snapshot = testState.snapshot;
    if (snapshot === null) throw new Error("expected snapshot seam");
    snapshot();
    const runPending = testState.runPendingImageJob;
    if (runPending === null)
      throw new Error("expected runPendingImageJob seam");

    runPending(async () => {
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    });
    // LandingComposer reads isIngestingImages on render; force a re-render.
    view.rerender(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));
    expect(testState.submit).not.toHaveBeenCalled();

    const release = gate.release;
    if (release === null) throw new Error("expected pending job gate");
    release();
    // Allow the job finally to clear ingesting, then re-render.
    await Promise.resolve();
    await Promise.resolve();
    view.rerender(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));
    expect(testState.submit).toHaveBeenCalledTimes(1);
  });

  // Finding 3: pure path-resolution must also hold submit open.
  it("blocks the actual landing submit path while file-path resolution is pending", () => {
    testState.resolvingPaths = true;
    const view = render(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );
    const installEditor = testState.installEditor;
    if (installEditor === null) throw new Error("expected ComposerBody seam");
    installEditor();
    const snapshot = testState.snapshot;
    if (snapshot === null) throw new Error("expected snapshot seam");
    snapshot();

    fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));
    expect(testState.submit).not.toHaveBeenCalled();

    testState.resolvingPaths = false;
    view.rerender(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));
    expect(testState.submit).toHaveBeenCalledTimes(1);
  });
});

function editorHandle(): ComposerPromptEditorHandle {
  const editorIncarnation = createComposerEditorIncarnation();
  return {
    isReady: () => true,
    getEditorIncarnation: () => editorIncarnation,
    hasFocus: () => false,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => DIRTY_CONTENT,
    isEmpty: () => false,
    clear: () => undefined,
    setContent: () => undefined,
    syncContent: () => undefined,
    insertImageAttachments: () => undefined,
    insertMentionAttachment: () => false,
    beginPathInsertion: () => null,
    rewriteImageAttachmentHashById: () => false,
    removeImageAttachmentById: () => undefined,
    insertDictatedText: () => undefined,
    draftGeneration: () => 0,
    dismissActiveSuggestion: () => false,
  };
}
