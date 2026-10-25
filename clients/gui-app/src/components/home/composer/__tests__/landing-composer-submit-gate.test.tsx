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
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { createStore } from "zustand/vanilla";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ComposerBodyProps } from "@/components/home/composer/composer-body";
import type {
  LandingStagedSandboxTaskArgs,
  LandingTerminalAgentArgs,
  TerminalAgentLaunch,
} from "@/components/home/hooks/use-landing-composer-actions";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import { LandingComposer } from "../landing-composer";
import { TerminalAccountFirstMention } from "@/components/home/pickers/terminal-account-first-mention";
import { useTerminalAccountMentionStore } from "@/stores/onboarding/terminal-account-mention-store";
import { SIGNED_OUT_SEND_HINT } from "@/components/chat/composer/use-provider-reauth-gate";
import {
  readStagedSandbox,
  useStagedSandboxStore,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";
import { useLandingPanelStore } from "@/stores/home/landing-panel-store";
import {
  pendingSendSurfaceKey,
  usePendingSandboxSendStore,
} from "@/stores/sandboxes/pending-sandbox-send-store";

const DIRTY_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "dirty" }] }],
};

/** The composer's own host client, as its placement names it. */
const PLACEMENT_CLIENT = vi.hoisted(() => ({ hostId: "host-test" }));

const testState = vi.hoisted(() => ({
  submit: vi.fn(),
  // Dispatches, as the real action does with no refusal to give.
  selectTerminalAgent: vi.fn((args: LandingTerminalAgentArgs): null => {
    args.settled?.(true);
    return null;
  }),
  /**
   * The task a staged sandbox's send opens: hands the message to it, as the
   * real action does before it navigates, and refuses nothing.
   */
  startTask: vi.fn((args: LandingStagedSandboxTaskArgs): null => {
    args.hand("epic-new");
    return null;
  }),
  /** What a sandbox host's agent gate says about the agent picked. */
  agentGate: {
    blocked: false,
    hint: null,
    notice: null,
  } as {
    readonly blocked: boolean;
    readonly hint: string | null;
    readonly notice: {
      readonly kind: "refused";
      readonly message: string;
      readonly action: {
        readonly label: string;
        readonly onAction: () => void;
      } | null;
    } | null;
  },
  /** What the staged send's sign-in check says: `null` lets it through. */
  stagedSignedOut: null as {
    readonly kind: "refused";
    readonly message: string;
    readonly action: {
      readonly label: string;
      readonly onAction: () => void;
    } | null;
  } | null,
  /** The agent the person picked, as the toolbar holds it raw. */
  pickHarness: "codex",
  pickModel: "gpt-6.1-sol",
  /** The composer's pack gate: the client it read and the harness it asked for. */
  packGateCalls: [] as Array<{
    readonly client: unknown;
    readonly harnessId: string | null;
  }>,
  /** Reads of the app-wide host's pack gate, which a composer must not make. */
  defaultHostPackGateReads: 0,
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
        readonly auth: { readonly status: "authenticated" | "unauthenticated" };
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
    auth: { status: "authenticated" },
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
        props.topBanner,
        React.createElement(
          "span",
          { "data-testid": "send-hint" },
          props.workspaceDisabledHint,
        ),
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

const landingDrafts = vi.hoisted(() => ({
  drafts: [] as Array<{ readonly id: string; closed: boolean }>,
  listeners: new Set<() => void>(),
}));

vi.mock("@/stores/home/landing-draft-store", () => {
  const state = {
    get drafts() {
      return landingDrafts.drafts;
    },
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
    {
      getState: () => state,
      subscribe: (listener: () => void) => {
        landingDrafts.listeners.add(listener);
        return () => {
          landingDrafts.listeners.delete(listener);
        };
      },
    },
  );
  return {
    useLandingDraftStore,
    isOpenLandingDraft: (draft: { readonly closed: boolean }) => !draft.closed,
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
    // The raw pick; `selection` above is what this host's catalog shows.
    values: {
      selection: {
        get harnessId() {
          return testState.pickHarness;
        },
        get modelSlug() {
          return testState.pickModel;
        },
        profileId: null,
      },
      permission: "supervised",
      reasoning: "high",
      serviceTier: "",
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

// The gates' own reads are covered by their hook tests; here the composer's
// use of their answers is what is under test.
// The Terminal-account line reads the host picker's options for the run's
// host; with none named it is this computer.
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return { useHostOptions: () => hostOptionsFixture({ hosts: [] }) };
});
vi.mock("@/hooks/sandboxes/use-sandbox-agent-gate", () => ({
  useSandboxAgentGate: () => testState.agentGate,
}));
vi.mock("@/hooks/sandboxes/use-staged-send-sign-in-check", () => ({
  useStagedSendSignInCheck: () => () => testState.stagedSignedOut,
}));

vi.mock("@/components/home/hooks/use-landing-composer-actions", () => ({
  useLandingComposerActions: () => ({
    submit: testState.submit,
    selectTerminalAgent: testState.selectTerminalAgent,
    startTaskOnStagedSandbox: testState.startTask,
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
  // The app-wide host's gate: a composer pinned to another machine must not
  // read it.
  useProviderPackGate: () => {
    testState.defaultHostPackGateReads += 1;
    return { blocked: false, hint: null, preparing: null };
  },
  useProviderPackGateForClient: (client: unknown, harnessId: string | null) => {
    testState.packGateCalls.push({ client, harnessId });
    return {
      blocked: testState.packBlocked,
      hint: testState.packBlocked ? "Preparing Claude Code… 40%" : null,
      preparing: null,
    };
  },
}));

vi.mock("@/components/chat/composer/use-profile-eligibility-gate", () => ({
  useProfileEligibilityGate: () => ({
    disabled: testState.profileDisabled,
    profileLabel: null,
    enablePending: false,
    enableProfile: vi.fn(),
  }),
}));

// The banner's own copy and sign-in flow are held by its own suite; here it is
// the marker that the landing composer put it above the send.
vi.mock("@/components/chat/composer/provider-reauth-banner", () => ({
  ProviderReauthBanner: (props: {
    readonly providerId: string;
    readonly reason: string;
  }) => (
    <div data-testid="reauth-banner">
      {props.providerId}:{props.reason}
    </div>
  ),
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
      client: PLACEMENT_CLIENT,
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
// The setup line prices a resting sandbox from the account's list.
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({ data: undefined }),
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
  usePendingSandboxSendStore.setState({ sends: {} });
  testState.startTask.mockClear();
  testState.pickHarness = "codex";
  testState.pickModel = "gpt-6.1-sol";
  testState.packGateCalls = [];
  testState.defaultHostPackGateReads = 0;
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
  testState.agentGate = { blocked: false, hint: null, notice: null };
  testState.stagedSignedOut = null;
});

const SHAPE = {
  os: "linux",
  cpus: 2,
  memoryMb: 4096,
  diskMb: null,
  region: "us-east",
  idleMinutes: 30,
  destroyAfterRestingMinutes: null,
} as const;

const NEW_STAGE: StagedSandboxTarget = {
  kind: "new",
  configuration: { kind: "personal" },
  shape: SHAPE,
  name: "",
  wakeString: null,
};

const EXISTING_RESUME: StagedSandboxTarget = {
  kind: "existing",
  hostId: "host-test",
  sandboxId: "sbx-build",
  name: "build-box",
  configuration: { kind: "personal" },
  verb: "resume",
};

const EXISTING_START: StagedSandboxTarget = {
  ...EXISTING_RESUME,
  verb: "start",
};

/** Types a draft and presses Send, as the person does. */
function sendFromComposer(): void {
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
}

function onlyPendingSend() {
  const sends = Object.values(usePendingSandboxSendStore.getState().sends);
  expect(sends).toHaveLength(1);
  return sends[0];
}

/** The stage the one pending send runs its create under. */
function onlyPendingStage() {
  const stages = Object.entries(useStagedSandboxStore.getState().bySurface);
  expect(stages.map(([key]) => key)).toEqual([
    pendingSendSurfaceKey(onlyPendingSend().id),
  ]);
  return stages[0][1];
}

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

  it("launches a staged Start on the new sandbox as the person put it together, with only the profile that host offers", () => {
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
    expect(testState.selectTerminalAgent.mock.calls[0][0].launch).toEqual({
      harnessId: "claude",
      model: "old-host-model",
      reasoningEffort: "high",
      terminalAgentArgs: "--resume",
      profileId: null,
    });
  });

  it("opens the terminal a resting row's Open terminal staged once its sandbox is awake, not before, and once", () => {
    useLandingPanelStore.getState().resetForTests();
    const store = useStagedSandboxStore.getState();
    store.stage("landing:window-test", {
      kind: "existing",
      hostId: "host-test",
      sandboxId: "sbx-build",
      name: "build-box",
      configuration: { kind: "personal" },
      verb: "resume",
    });
    store.report("landing:window-test", { openTerminal: true });
    const view = render(
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
    expect(useLandingPanelStore.getState().terminalRequest).toBeNull();

    act(() => {
      useStagedSandboxStore.getState().report("landing:window-test", {
        phase: "handoff",
        createdHostId: "host-test",
      });
    });

    expect(useLandingPanelStore.getState().terminalRequest?.hostId).toBe(
      "host-test",
    );

    // The panel serves it; a composer that remounts mid-handoff asks for none.
    act(() => {
      useLandingPanelStore.getState().clearTerminalRequest();
    });
    expect(readStagedSandbox("landing:window-test")?.phase).toBe("handoff");
    view.unmount();
    render(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );
    expect(useLandingPanelStore.getState().terminalRequest).toBeNull();
  });

  it("keeps a send's handoff while its draft's page is away, and drops the send when the draft closes", async () => {
    landingDrafts.drafts = [{ id: "draft-open", closed: false }];
    onTestFinished(() => {
      landingDrafts.drafts = [];
    });
    const store = useStagedSandboxStore.getState();
    store.stage("landing:window-test", {
      kind: "existing",
      hostId: "host-test",
      sandboxId: "sbx-build",
      name: "build-box",
      configuration: { kind: "personal" },
      verb: "resume",
    });
    // Sent from the draft; the new host's catalog has not answered yet.
    store.report("landing:window-test", {
      phase: "handoff",
      createdHostId: "host-test",
      ownerId: "draft-open",
      sendTaken: true,
    });
    const view = render(
      <LandingComposer
        draftId="draft-open"
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );

    // Another draft took the page, or the page was evicted.
    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(readStagedSandbox("landing:window-test")?.phase).toBe("handoff");

    act(() => {
      landingDrafts.drafts = [{ id: "draft-open", closed: true }];
      for (const listener of landingDrafts.listeners) listener();
    });
    expect(readStagedSandbox("landing:window-test")).toBeNull();
  });

  it("hands the next draft's send to its task while the sandbox the closed draft's terminal started boots", async () => {
    landingDrafts.drafts = [
      { id: "draft-a", closed: false },
      { id: "draft-b", closed: false },
    ];
    onTestFinished(() => {
      landingDrafts.drafts = [];
    });
    const store = useStagedSandboxStore.getState();
    store.stage("landing:window-test", EXISTING_RESUME);
    store.begin("landing:window-test", false, Date.now(), false);
    store.report("landing:window-test", {
      ownerId: "draft-a",
      sendTaken: true,
    });
    const draftA = render(
      <LandingComposer
        draftId="draft-a"
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );
    draftA.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      landingDrafts.drafts = [
        { id: "draft-a", closed: true },
        { id: "draft-b", closed: false },
      ];
      for (const listener of landingDrafts.listeners) listener();
    });
    expect(readStagedSandbox("landing:window-test")).toMatchObject({
      phase: "creating",
      ownerId: null,
      sendTaken: false,
    });

    const draftB = (
      <LandingComposer
        draftId="draft-b"
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />
    );
    const view = render(draftB);
    const installEditor = testState.installEditor;
    if (installEditor === null) throw new Error("expected ComposerBody seam");
    installEditor();
    const snapshot = testState.snapshot;
    if (snapshot === null) throw new Error("expected snapshot seam");
    snapshot();
    view.rerender(draftB);
    fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));

    // The send takes the stage as it stands, mid-boot, to its task.
    expect(testState.submit).not.toHaveBeenCalled();
    expect(testState.startTask).toHaveBeenCalledTimes(1);
    expect(readStagedSandbox("landing:window-test")).toBeNull();
    expect(onlyPendingStage()).toMatchObject({ phase: "creating" });
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

  it.each([
    ["workspace folder is unresolved", "workspaceReady", false],
    ["selected profile is ineligible", "profileDisabled", true],
    ["provider pack is downloading", "packBlocked", true],
  ] as const)(
    "hands a send to a staged sandbox's task though this host's %s",
    (_label, gate, value) => {
      testState[gate] = value;
      useStagedSandboxStore.getState().stage("landing:window-test", NEW_STAGE);

      sendFromComposer();

      expect(testState.submit).not.toHaveBeenCalled();
      expect(testState.startTask).toHaveBeenCalledTimes(1);
      expect(onlyPendingSend()).toMatchObject({
        epicId: "epic-new",
        request: { kind: "chat", parentId: null },
        text: "dirty",
      });
    },
  );

  it("hands the send of a person with no model to pick yet to the staged sandbox's task", () => {
    testState.modelSlug = "";
    testState.pickHarness = "claude";
    testState.pickModel = "";
    useStagedSandboxStore.getState().stage("landing:window-test", NEW_STAGE);

    sendFromComposer();

    expect(testState.submit).not.toHaveBeenCalled();
    expect(onlyPendingSend().settings).toMatchObject({
      harnessId: "claude",
      model: "",
    });
  });

  // The task runs on the agent the person chose, never one the sandbox's
  // catalog would put in its place while its pack is still preparing: the
  // toolbar shows Claude here, and the pick is Codex · GPT-6.1-Sol · High.
  it.each([
    ["a new sandbox", NEW_STAGE],
    ["a suspended sandbox", EXISTING_RESUME],
    ["a stopped sandbox", EXISTING_START],
  ] as const)(
    "sends to %s on the model the person picked, not the one the toolbar shows",
    (_label, target) => {
      useStagedSandboxStore.getState().stage("landing:window-test", target);

      sendFromComposer();

      expect(onlyPendingSend().settings).toEqual({
        harnessId: "codex",
        model: "gpt-6.1-sol",
        permissionMode: "supervised",
        reasoningEffort: "high",
        serviceTier: null,
        agentMode: "regular",
        profileId: null,
      });
    },
  );

  it("moves the composer's stage to the send, create key included, and keeps the composer's own empty", () => {
    useStagedSandboxStore.getState().stage("landing:window-test", NEW_STAGE);
    const clientRequestId = useStagedSandboxStore
      .getState()
      .begin("landing:window-test", false, 1_000, false);

    sendFromComposer();

    expect(readStagedSandbox("landing:window-test")).toBeNull();
    expect(onlyPendingStage()).toMatchObject({ clientRequestId });
  });

  describe("the Terminal-account line under the composer's own surface", () => {
    function renderWithMention(): void {
      render(
        <LandingComposer
          draftId={null}
          pendingCreateId={null}
          initialSettings={null}
          workspaceControls={() => (
            <TerminalAccountFirstMention named runTargetHostId={null} />
          )}
        />,
      );
    }

    beforeEach(() => {
      useTerminalAccountMentionStore.setState({ explained: false });
    });

    it("names the sandbox staged on this composer, in place of this computer", () => {
      useStagedSandboxStore
        .getState()
        .stage("landing:window-test", { ...NEW_STAGE, name: "e2e-sbx-p1" });

      renderWithMention();

      expect(
        screen.getByTestId("terminal-account-first-mention").textContent,
      ).toBe(
        "e2e-sbx-p1's own sign-in, which stays on e2e-sbx-p1. Link a plan to use one everywhere.",
      );
    });

    it("names this computer when nothing is staged on this composer", () => {
      renderWithMention();

      expect(
        screen.getByTestId("terminal-account-first-mention").textContent,
      ).toBe(
        "This computer's own sign-in, which stays on this computer. Link a plan to use one everywhere.",
      );
    });
  });

  describe("refusals at Send", () => {
    const SENTENCE = "Sign in to a coding agent to run agents on Personal.";

    function refusal(onAction: () => void) {
      return {
        kind: "refused" as const,
        message: SENTENCE,
        action: { label: "Open Personal's Providers", onAction },
      };
    }

    it("refuses an agent that cannot run on the sandbox host with the Providers link, creating nothing and keeping the draft", () => {
      const openProviders = vi.fn();
      testState.agentGate = {
        blocked: true,
        hint: SENTENCE,
        notice: refusal(openProviders),
      };

      sendFromComposer();

      expect(screen.getByRole("alert").textContent).toContain(SENTENCE);
      expect(testState.submit).not.toHaveBeenCalled();
      expect(testState.startTask).not.toHaveBeenCalled();
      expect(Object.keys(usePendingSandboxSendStore.getState().sends)).toEqual(
        [],
      );
      // The draft stays: the composer is still there to send again from.
      expect(
        screen.getByRole("button", { name: "Submit landing" }),
      ).toBeDefined();

      fireEvent.click(screen.getByTestId("composer-host-notice-action"));
      expect(openProviders).toHaveBeenCalledTimes(1);
    });

    it("lets the same send through on a host the gate does not hold", () => {
      sendFromComposer();

      expect(screen.queryByRole("alert")).toBeNull();
      expect(testState.submit).toHaveBeenCalledTimes(1);
    });

    it("refuses a staged send whose agent is signed out on the staged configuration, before any create or wake", () => {
      const openProviders = vi.fn();
      testState.stagedSignedOut = refusal(openProviders);
      useStagedSandboxStore.getState().stage("landing:window-test", NEW_STAGE);

      sendFromComposer();

      expect(screen.getByRole("alert").textContent).toContain(SENTENCE);
      expect(testState.startTask).not.toHaveBeenCalled();
      expect(testState.submit).not.toHaveBeenCalled();
      expect(Object.keys(usePendingSandboxSendStore.getState().sends)).toEqual(
        [],
      );
      // Still staged on the composer, nothing begun.
      expect(readStagedSandbox("landing:window-test")).toMatchObject({
        phase: "staged",
        clientRequestId: null,
      });

      fireEvent.click(screen.getByTestId("composer-host-notice-action"));
      expect(openProviders).toHaveBeenCalledTimes(1);
    });
  });

  it("reads the pack gate of the composer's own host, never the app-wide one", () => {
    render(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );

    expect(testState.defaultHostPackGateReads).toBe(0);
    expect(testState.packGateCalls.length).toBeGreaterThan(0);
    for (const call of testState.packGateCalls) {
      expect(call.client).toBe(PLACEMENT_CLIENT);
    }
  });

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

  it("refuses a send while the provider's terminal login is signed out, says why on the send button, and shows the sign-in banner above it", () => {
    testState.providers = [
      {
        ...claudeCodeProvider(null),
        auth: { status: "unauthenticated" },
      },
    ];
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
    expect(screen.getByTestId("send-hint").textContent).toBe(
      SIGNED_OUT_SEND_HINT,
    );
    expect(screen.getByTestId("reauth-banner").textContent).toBe(
      "claude-code:provider_unauthenticated",
    );

    act(() => {
      answerProviders([claudeCodeProvider(null)]);
    });
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
    expect(screen.queryByTestId("reauth-banner")).toBeNull();
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
