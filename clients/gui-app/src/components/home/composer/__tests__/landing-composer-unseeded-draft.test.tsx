/**
 * A draft minted before the composer's host resolved holds nothing, and the
 * draft outranks the host's memory for as long as it lives. The installed phone
 * has one such draft for life, so the composer gives it that memory once the
 * host resolves. Real draft, run-settings and folder stores and the real
 * toolbar store, under the real shell read the Start Page passes down.
 */
import {
  act,
  cleanup,
  render as renderComponent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { GuiHarnessId } from "@traycer/protocol/host/index";

import type { ModelOption } from "@/components/home/data/landing-options";
import type { ComposerBodyProps } from "@/components/home/composer/composer-body";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";

const host = vi.hoisted(() => ({
  /** The composer's placement. `null` until the host resolves. */
  resolvedHostId: null as string | null,
  toolbar: null as ComposerToolbarStore | null,
}));
const PLACEMENT_CLIENT = vi.hoisted(() => ({ hostId: "placement-client" }));

function modelOption(harnessId: GuiHarnessId, slug: string): ModelOption {
  return {
    harnessId,
    slug,
    label: slug,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

// Stable references: a fresh list per render would push a new catalog on
// every render.
const HARNESSES = {
  harnesses: [
    { id: "claude", available: true },
    { id: "traycer", available: true },
  ],
};
const MODELS = {
  models: [modelOption("claude", "sonnet"), modelOption("traycer", "default")],
};

vi.mock(
  "@/hooks/harnesses/use-gui-harness-catalog",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/harnesses/use-gui-harness-catalog")
    >()),
    useGuiHarnessesQueryForClient: () => ({ data: HARNESSES }),
    useGuiHarnessModelsQueryForClient: () => ({ data: MODELS }),
  }),
);
vi.mock("@/hooks/sandboxes/use-sandbox-traycer-models-query", () => ({
  useSandboxTraycerModels: () => ({
    data: undefined,
    isPending: true,
    isFetching: false,
    fetchStatus: "idle" as const,
    isError: false,
  }),
}));
vi.mock("@/hooks/command-palette/use-register-composer-controls", () => ({
  useRegisterFocusedComposerControls: () => undefined,
}));
vi.mock("@/hooks/providers/use-resolved-seeded-profile-id", () => ({
  useResolvedSeededProfileId: (_harnessId: string, profileId: string | null) =>
    profileId,
}));
vi.mock("@/components/home/composer/composer-body", () => ({
  ComposerBody: (props: ComposerBodyProps) => {
    host.toolbar = props.toolbarStore;
    return null;
  },
}));
vi.mock("@/hooks/host/use-composer-placement", () => ({
  useComposerPlacement: () => ({
    pin: {
      selection: null,
      setSelection: () => undefined,
      resolvedHostId: host.resolvedHostId,
      isPinned: false,
      latchOnFirstUse: () => undefined,
    },
    target: {
      resolvedHostId: host.resolvedHostId,
      client: host.resolvedHostId === null ? null : PLACEMENT_CLIENT,
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
    useComposerSurfaceHostKey: () => "landing:window-test",
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
vi.mock(
  "@/hooks/composer/use-landing-composer-paste",
  async (importActual) => ({
    ...(await importActual<
      typeof import("@/hooks/composer/use-landing-composer-paste")
    >()),
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
  }),
);
vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => ({ folders: [], isLoading: false }),
}));
vi.mock("@/lib/composer/workspace-composer-availability", () => ({
  deriveFolderlessAllowedWorkspaceAvailability: () => ({ disabledHint: null }),
  workspaceComposerCanStart: () => true,
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
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));
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
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";
import {
  isUnseededLandingDraft,
  useLandingDraftShell,
  useLandingDraftStore,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";

const REMEMBERING_HOST = "host-remembering";
const ALSO_REMEMBERING_HOST = "host-also-remembering";
const BLANK_HOST = "host-blank";
const OTHER_BLANK_HOST = "host-blank-too";
const DRAFT_ID = "draft-unseeded";

const MANAGED_RUN: ChatRunSettings = {
  ultracode: false,
  harnessId: "claude",
  model: "sonnet",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: "work",
};
const FOLDER = {
  path: "/repo",
  name: "repo",
  repoIdentifier: null,
  hostId: REMEMBERING_HOST,
};

/** What the Start Page does: the composer's seed is the draft row's settings. */
function ComposerOnStartPage() {
  const { settings } = useLandingDraftShell(DRAFT_ID);
  return (
    <LandingComposer
      draftId={DRAFT_ID}
      pendingCreateId={null}
      initialSettings={settings}
      workspaceControls={() => null}
    />
  );
}

/** Mounts the composer; the result moves its placement to another host. */
function mountComposer(): (hostId: string) => void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <ComposerOnStartPage />
    </QueryClientProvider>
  );
  const view = renderComponent(tree());
  return (hostId) => {
    host.resolvedHostId = hostId;
    act(() => {
      view.rerender(tree());
    });
  };
}

function draftRow(id: string): LandingDraftTab {
  const row = useLandingDraftStore
    .getState()
    .drafts.find((draft) => draft.id === id);
  if (row === undefined) throw new Error(`no draft ${id}`);
  return row;
}

beforeEach(() => {
  localStorage.clear();
  host.resolvedHostId = null;
  host.toolbar = null;
  useStagedSandboxStore.setState({ bySurface: {} });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useWorkspaceFoldersStore.setState({ byHost: {} });
  useComposerHarnessMemoryStore.getState().resetForTests();
  useComposerRunSettingsStore.getState().resetForTests();
  // No selection authority yet: the phone at boot.
  useSelectionAuthorityStore.setState({
    attached: false,
    effectiveHostId: null,
    leases: [],
  });
  useComposerRunSettingsStore
    .getState()
    .setGlobalRunSettings(REMEMBERING_HOST, MANAGED_RUN, 1);
  useWorkspaceFoldersStore
    .getState()
    .addResolvedFolders(REMEMBERING_HOST, [FOLDER]);
  useLandingDraftStore.getState().createDraftWithId(DRAFT_ID, null);
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("a landing composer over a draft minted before its host resolved", () => {
  it("gives the draft that host's settings and folders, and shows that profile", async () => {
    const resolveHost = mountComposer();
    const minted = draftRow(DRAFT_ID);
    expect(isUnseededLandingDraft(minted)).toBe(true);
    expect(host.toolbar?.getState().selection.profileId).toBeNull();

    resolveHost(REMEMBERING_HOST);

    const seeded = draftRow(DRAFT_ID);
    expect(seeded.settings).toEqual(MANAGED_RUN);
    expect(seeded.workspace.folders).toEqual([FOLDER.path]);
    expect(seeded.workspace.primaryPath).toBe(FOLDER.path);
    expect(seeded.generation).toBe(minted.generation + 1);
    await waitFor(() =>
      expect(host.toolbar?.getState().selection.profileId).toBe("work"),
    );
    expect(draftRow(DRAFT_ID).settings).toEqual(MANAGED_RUN);
  });

  it("leaves a seeded draft alone when the placement moves to another host with memory", () => {
    const resolveHost = mountComposer();
    resolveHost(REMEMBERING_HOST);
    const seeded = draftRow(DRAFT_ID);

    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(
        ALSO_REMEMBERING_HOST,
        { ...MANAGED_RUN, profileId: "other" },
        1,
      );
    resolveHost(ALSO_REMEMBERING_HOST);

    expect(draftRow(DRAFT_ID)).toBe(seeded);
  });

  it("writes nothing across hosts that remember nothing, then seeds on one that does", () => {
    const resolveHost = mountComposer();
    const minted = draftRow(DRAFT_ID);

    resolveHost(BLANK_HOST);
    resolveHost(OTHER_BLANK_HOST);

    expect(draftRow(DRAFT_ID)).toBe(minted);

    resolveHost(REMEMBERING_HOST);

    expect(draftRow(DRAFT_ID).settings).toEqual(MANAGED_RUN);
    expect(draftRow(DRAFT_ID).generation).toBe(minted.generation + 1);
  });

  it("forks a replica rather than writing another host's row", () => {
    useLandingDraftStore.setState((state) => ({
      drafts: state.drafts.map((draft) =>
        draft.id === DRAFT_ID
          ? { ...draft, origin: "replica" as const }
          : draft,
      ),
    }));
    const resolveHost = mountComposer();

    resolveHost(REMEMBERING_HOST);

    const fork = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.supersedes === DRAFT_ID);
    expect(fork?.settings).toEqual(MANAGED_RUN);
    expect(fork?.workspace.folders).toEqual([FOLDER.path]);
    expect(fork?.origin).toBeNull();
  });
});
