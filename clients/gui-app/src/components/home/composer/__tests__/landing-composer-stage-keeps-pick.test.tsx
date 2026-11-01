import {
  act,
  cleanup,
  render as renderComponent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ComposerBodyProps } from "@/components/home/composer/composer-body";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";

// What the host can run: the person's Codex pick is not among it, so Claude
// is shown.
const host = vi.hoisted(() => ({
  harnesses: {
    harnesses: [
      { id: "claude", available: true },
      { id: "codex", available: false },
    ],
  },
  toolbar: null as ComposerToolbarStore | null,
  editContent: null as ComposerBodyProps["onDocumentChange"] | null,
}));

const PLACEMENT_CLIENT = vi.hoisted(() => ({ hostId: "host-test" }));
const HOST_ID = "host-test";
const SURFACE = "landing:window-test";

function modelOption(harnessId: string, slug: string) {
  return {
    harnessId,
    slug,
    label: slug,
    description: null,
    isDefault: true,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [
      { id: "low", label: "Low", description: null },
      { id: "high", label: "High", description: null },
    ],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

// Stable references: a fresh list per render would push a new catalog on
// every render.
const CLAUDE_MODELS = { models: [modelOption("claude", "sonnet-5.5")] };
const CODEX_MODELS = { models: [modelOption("codex", "gpt-6-astra")] };

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: () => ({ data: host.harnesses }),
  useGuiHarnessModelsQueryForClient: (_client: unknown, harnessId: string) => ({
    data: harnessId === "claude" ? CLAUDE_MODELS : CODEX_MODELS,
  }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-traycer-models-query", () => ({
  useSandboxTraycerModels: () => ({ data: undefined }),
}));
vi.mock("@/hooks/command-palette/use-register-composer-controls", () => ({
  useRegisterFocusedComposerControls: () => undefined,
}));
vi.mock("@/hooks/providers/use-resolved-seeded-profile-id", () => ({
  useResolvedSeededProfileId: (_harnessId: string, profileId: string | null) =>
    profileId,
}));

// The editor and toolbar chrome are held by their own suites; the body hands
// back the real toolbar store the composer built and the edit handler.
vi.mock("@/components/home/composer/composer-body", () => ({
  ComposerBody: (props: ComposerBodyProps) => {
    host.toolbar = props.toolbarStore;
    host.editContent = props.onDocumentChange;
    return null;
  },
}));

vi.mock("@/hooks/host/use-composer-placement", () => ({
  useComposerPlacement: () => ({
    pin: {
      selection: null,
      setSelection: () => undefined,
      resolvedHostId: HOST_ID,
      isPinned: false,
      latchOnFirstUse: () => undefined,
    },
    target: {
      resolvedHostId: HOST_ID,
      client: PLACEMENT_CLIENT,
      hostLabel: "Local",
      isPinned: false,
      namedHostDead: false,
    },
    hostLabelFor: () => "Local",
  }),
}));
vi.mock(
  "@/hooks/host/use-composer-surface-host-pin",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/host/use-composer-surface-host-pin")
    >()),
    useComposerSurfaceHostKey: () => SURFACE,
  }),
);
vi.mock("@/components/home/hooks/use-landing-composer-actions", () => ({
  useLandingComposerActions: () => ({
    submit: vi.fn(),
    selectTerminalAgent: vi.fn(),
    startTaskOnStagedSandbox: vi.fn(),
    placementAdmitsTask: () => true,
    isPending: false,
    attachmentUpload: null,
  }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-agent-gate", () => ({
  useSandboxAgentGate: () => ({ blocked: false, hint: null, notice: null }),
}));
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return { useHostOptions: () => hostOptionsFixture({ hosts: [] }) };
});
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
  useRunnerHost: () => ({
    signInUrl: "https://billing.test",
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
    useLandingComposerPaste: () => ({
      onPaste: vi.fn(),
      onDrop: vi.fn(),
      onDragOver: vi.fn(),
      onDragEnter: vi.fn(),
      onDragLeave: vi.fn(),
      attachImageFiles: vi.fn(),
      runPendingImageJob: vi.fn(),
      isDraggingFiles: false,
      dragOverlayVariant: null,
      isIngestingImages: false,
      isResolvingFilePaths: false,
    }),
  };
});
vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => ({ folders: [], isLoading: false }),
}));
vi.mock("@/lib/composer/workspace-composer-availability", () => ({
  deriveFolderlessAllowedWorkspaceAvailability: () => ({ disabledHint: null }),
  workspaceComposerCanStart: () => true,
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
  useProviderPackGate: () => ({ blocked: false, hint: null, preparing: null }),
  useProviderPackGateForClient: () => ({
    blocked: false,
    hint: null,
    preparing: null,
  }),
}));
vi.mock("@/components/chat/composer/use-profile-eligibility-gate", () => ({
  useProfileEligibilityGate: () => ({
    disabled: false,
    profileLabel: null,
    enablePending: false,
    enableProfile: vi.fn(),
  }),
}));
vi.mock("@/components/chat/composer/provider-reauth-banner", () => ({
  ProviderReauthBanner: () => null,
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
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({
    data: null,
    refetch: () => Promise.resolve({ data: null, isError: false }),
  }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({
    data: { providers: [] },
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-defaults", () => ({
  useSandboxDefaultsLookup: () => () => null,
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: vi.fn() }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({ data: undefined }),
}));
vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostClient: () => null,
  useHostDirectory: () => ({
    findById: () => null,
    onChange: () => ({ dispose: () => undefined }),
  }),
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
vi.mock(
  "@/hooks/providers/use-providers-list-query",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/providers/use-providers-list-query")
    >()),
    useProvidersListForClient: () => ({ data: undefined, isError: false }),
  }),
);

import { LandingComposer } from "../landing-composer";
import { pickedRunSettings } from "@/lib/sandboxes/pending-sandbox-send";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  useStagedSandboxStore,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";

// The person's own pick, as their last run left it.
const PICK: ChatRunSettings = {
  ultracode: false,
  harnessId: "codex",
  model: "gpt-6-astra",
  permissionMode: "supervised",
  reasoningEffort: "low",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const NEW_STAGE: StagedSandboxTarget = {
  kind: "new",
  configuration: { kind: "personal" },
  shape: {
    os: "linux",
    cpus: 2,
    memoryMb: 8192,
    diskMb: null,
    region: "us-east",
    idleMinutes: 30,
    destroyAfterRestingMinutes: null,
  },
  name: "",
  wakeString: null,
};

const TYPED: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
};

function render(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderComponent(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

function mount(
  draftId: string | null,
  initialSettings: ChatRunSettings | null,
) {
  return render(
    <LandingComposer
      draftId={draftId}
      pendingCreateId={draftId === null ? "pending-draft" : null}
      initialSettings={initialSettings}
      workspaceControls={() => null}
    />,
  );
}

function draftSettings(draftId: string): ChatRunSettings | null {
  return (
    useLandingDraftStore.getState().drafts.find((d) => d.id === draftId)
      ?.settings ?? null
  );
}

function toolbar(): ComposerToolbarStore {
  if (host.toolbar === null) throw new Error("the composer did not mount");
  return host.toolbar;
}

function lastRunSettings() {
  return useComposerRunSettingsStore.getState().getGlobalRunSettings(HOST_ID);
}

beforeEach(() => {
  localStorage.clear();
  host.toolbar = null;
  host.editContent = null;
  useStagedSandboxStore.setState({ bySurface: {} });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useComposerHarnessMemoryStore.getState().resetForTests();
  useComposerRunSettingsStore.getState().resetForTests();
  useComposerRunSettingsStore.getState().setGlobalRunSettings(HOST_ID, PICK, 1);
});

afterEach(() => {
  cleanup();
});

describe("a landing composer with a sandbox staged", () => {
  it("writes the kept pick to its draft and not to the host's last-run settings, and shows it after a reload", async () => {
    const draftId = useLandingDraftStore.getState().createDraft(PICK);
    const lastRun = lastRunSettings();
    const first = mount(draftId, draftSettings(draftId));
    await waitFor(() =>
      expect(toolbar().getState().selection.harnessId).toBe("claude"),
    );

    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, NEW_STAGE);
    });

    await waitFor(() =>
      expect(draftSettings(draftId)?.harnessId).toBe("claude"),
    );
    expect(lastRunSettings()).toBe(lastRun);
    expect(useComposerHarnessMemoryStore.getState().byHost).toEqual({});

    // The reload: a fresh composer on the draft, the stage still up.
    first.unmount();
    mount(draftId, draftSettings(draftId));
    await waitFor(() =>
      expect(toolbar().getState().catalog.keepsUnavailablePick).toBe(true),
    );
    expect(toolbar().getState().selection.harnessId).toBe("claude");
    expect(pickedRunSettings(toolbar().getState()).harnessId).toBe("claude");
  });

  it("mints a draft that holds the kept pick, not the host's last-run pick", async () => {
    const lastRun = lastRunSettings();
    mount(null, null);
    await waitFor(() =>
      expect(toolbar().getState().selection.harnessId).toBe("claude"),
    );
    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, NEW_STAGE);
    });
    await waitFor(() =>
      expect(toolbar().getState().values.selection.harnessId).toBe("claude"),
    );

    // The first real edit mints the draft.
    act(() => {
      host.editContent?.(TYPED, { from: 1, to: 1 });
    });

    const minted = useLandingDraftStore.getState().drafts;
    expect(minted).toHaveLength(1);
    expect(minted[0]?.settings?.harnessId).toBe("claude");
    expect(minted[0]?.settings?.model).toBe("sonnet-5.5");
    expect(lastRunSettings()).toBe(lastRun);
  });

  it("mints a draft from the host's last run when no sandbox is staged", async () => {
    mount(null, null);
    await waitFor(() =>
      expect(toolbar().getState().selection.harnessId).toBe("claude"),
    );

    act(() => {
      host.editContent?.(TYPED, { from: 1, to: 1 });
    });

    const minted = useLandingDraftStore.getState().drafts;
    expect(minted).toHaveLength(1);
    expect(minted[0]?.settings?.harnessId).toBe("codex");
  });
});
