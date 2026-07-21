import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { createStore } from "zustand/vanilla";
import type { ReactNode } from "react";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { ModelOption } from "@/components/home/data/landing-options";
import type {
  ProfileRateLimitDestination,
  ProfileRateLimitSwitchPrompt,
} from "@/components/chat/composer/use-profile-rate-limit-switch-prompt";

import { LandingComposer } from "../landing-composer";

interface CapturedPromptArgs {
  readonly harnessId: unknown;
  readonly profileId: unknown;
  readonly selectedModel: ModelOption | null;
  readonly active: unknown;
  readonly client: unknown;
}

interface CapturedBannerProps {
  readonly runTargetHostId: string | null;
  readonly probeTarget: ProfileRateLimitDestination | null;
  readonly affectedChatCount: number;
  readonly onSwitchProfile: (profileId: string | null) => void;
  readonly onSwitchProfileForTask: (profileId: string | null) => void;
  readonly onDismiss: () => void;
}

const testState = vi.hoisted<{
  prompt: ProfileRateLimitSwitchPrompt;
  promptArgs: CapturedPromptArgs | null;
  bannerProps: CapturedBannerProps | null;
  commitProfileSelection: Mock;
  surfaceActive: boolean;
  seededModel: ModelOption;
}>(() => ({
  prompt: { kind: "hidden", dismiss: vi.fn() },
  promptArgs: null as CapturedPromptArgs | null,
  bannerProps: null as CapturedBannerProps | null,
  commitProfileSelection: vi.fn(),
  surfaceActive: true,
  seededModel: {
    harnessId: "claude",
    slug: "claude-sonnet",
    label: "Sonnet",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  },
}));

vi.mock("@/components/home/composer/composer-body", async () => {
  const React = await import("react");
  return {
    ComposerBody: (props: { topBanner: ReactNode }) =>
      React.createElement(
        "div",
        { "data-testid": "composer-body" },
        props.topBanner,
      ),
  };
});

vi.mock(
  "@/components/chat/composer/use-profile-rate-limit-switch-prompt",
  () => ({
    useProfileRateLimitSwitchPrompt: (args: CapturedPromptArgs) => {
      testState.promptArgs = args;
      return testState.prompt;
    },
  }),
);

vi.mock(
  "@/components/chat/composer/profile-rate-limit-switch-banner",
  async () => {
    const React = await import("react");
    return {
      ProfileRateLimitSwitchBanner: (props: CapturedBannerProps) => {
        testState.bannerProps = props;
        return React.createElement("div", {
          "data-testid": "rate-limit-banner",
        });
      },
    };
  },
);

vi.mock("@/stores/composer/commit-selection", () => ({
  commitProfileSelection: (...args: Array<unknown>): void => {
    testState.commitProfileSelection(...args);
  },
}));

vi.mock(
  "@/hooks/providers/use-refresh-providers-list-on-turn-default-host",
  () => ({
    useRefreshProvidersListOnTurnDefaultHost: vi.fn(),
  }),
);

vi.mock("@/stores/composer/landing-composer-store", () => {
  const dirtyContent = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "dirty" }] },
    ],
  };
  const state = {
    currentContent: dirtyContent,
    setSnapshot: vi.fn(),
    openDraft: () => dirtyContent,
  };
  const useLandingComposerStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  );
  return {
    useLandingComposerStore,
    flushPendingLandingDraftContent: vi.fn(),
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
  };
  return {
    useLandingDraftStore: (selector: (value: typeof state) => unknown) =>
      selector(state),
  };
});

vi.mock("@/stores/composer/composer-run-settings-store", () => {
  const state = {
    globalLastRunSettings: null,
    setGlobalRunSettings: vi.fn(),
  };
  return {
    useComposerRunSettingsStore: (selector: (value: typeof state) => unknown) =>
      selector(state),
  };
});

vi.mock("@/components/home/hooks/use-composer-toolbar-store", () => {
  const toolbarStore = createStore(() => ({
    selection: {
      harnessId: "claude",
      modelSlug: "claude-sonnet",
      profileId: null,
    },
    selectedModel: testState.seededModel,
    permission: "supervised",
    reasoning: "medium",
    serviceTier: "",
    agentMode: "regular",
  }));
  return { useComposerToolbarStore: () => toolbarStore };
});

vi.mock("@/components/home/hooks/use-landing-composer-actions", () => ({
  useLandingComposerActions: () => ({
    submit: vi.fn(),
    selectTerminalAgent: vi.fn(),
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

vi.mock("@/hooks/composer/use-landing-composer-paste", () => ({
  useLandingComposerPaste: () => ({
    onPaste: vi.fn(),
    onDrop: vi.fn(),
    onDragOver: vi.fn(),
    onDragEnter: vi.fn(),
    onDragLeave: vi.fn(),
    attachImageFiles: vi.fn(),
    isDraggingFiles: false,
    isIngestingImages: false,
  }),
}));

vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => ({ folders: [], isLoading: false }),
}));

vi.mock("@/lib/composer/workspace-composer-availability", () => ({
  deriveFolderlessAllowedWorkspaceAvailability: () => ({
    disabledHint: null,
  }),
  workspaceComposerCanStart: () => true,
}));

vi.mock("@/components/home/composer/surface-activity-hooks", () => ({
  useSurfaceActivity: () => testState.surfaceActive,
}));
vi.mock("@/components/chat/composer/picker/use-composer-picker-items", () => ({
  useComposerPickerItems: () => undefined,
}));
vi.mock("@/hooks/composer/use-workspace-mention-roots", () => ({
  useLandingComposerMentionRoots: () => [],
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
vi.mock("@/hooks/epic/use-epic-create-mutation", () => ({
  useEpicCreate: () => ({ isPending: false }),
}));
vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgent: () => ({ isPending: false }),
}));
vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostClient: () => null,
}));

function profile(
  profileId: string,
  kind: "ambient" | "managed",
): ProviderProfile {
  return {
    profileId,
    kind,
    authType: "oauth",
    label: profileId,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "near_limit",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function renderLandingComposer(): RenderResult {
  return render(
    <LandingComposer
      draftId={null}
      initialSettings={null}
      workspaceControls={null}
    />,
  );
}

afterEach(() => {
  cleanup();
  testState.prompt = { kind: "hidden", dismiss: vi.fn() };
  testState.promptArgs = null;
  testState.bannerProps = null;
  testState.commitProfileSelection.mockClear();
  testState.surfaceActive = true;
});

describe("LandingComposer rate-limit banner wiring", () => {
  it("mounts nothing while the shared prompt hook reports hidden", () => {
    renderLandingComposer();
    expect(screen.queryByTestId("rate-limit-banner")).toBeNull();
  });

  it("mounts the banner flush above the composer with full state parity minus the task checkbox", () => {
    const current = profile("profile-a", "managed");
    const other = profile("profile-b", "managed");
    const dismiss = vi.fn();
    testState.prompt = {
      kind: "visible",
      warningKey: "warning-key-1",
      providerId: "claude-code",
      severity: "near_limit",
      limitedFamilies: [],
      current,
      profiles: [current, other],
      destinations: [
        { profile: other, profileId: "profile-b", selectable: true },
      ],
      primaryTarget: {
        profile: other,
        profileId: "profile-b",
        selectable: true,
      },
      probeTarget: null,
      dismiss,
    };

    renderLandingComposer();

    expect(screen.getByTestId("rate-limit-banner")).toBeTruthy();
    const bannerProps = testState.bannerProps;
    if (bannerProps === null) throw new Error("expected banner props");
    // Task-wide checkbox is never wired: affectedChatCount is fixed at 0.
    expect(bannerProps.affectedChatCount).toBe(0);
    // Landing has no tab; the usage sidecar/R-key refresh must resolve to
    // the app-wide default host, never a stray non-null id.
    expect(bannerProps.runTargetHostId).toBeNull();
    expect(bannerProps.probeTarget).toBeNull();

    bannerProps.onSwitchProfile("profile-b");
    expect(testState.commitProfileSelection).toHaveBeenCalledTimes(1);
    expect(testState.commitProfileSelection.mock.calls[0][1]).toBe("profile-b");

    // Never wired to anything that could switch other chats/tasks.
    expect(() => bannerProps.onSwitchProfileForTask("profile-b")).not.toThrow();
    expect(testState.commitProfileSelection).toHaveBeenCalledTimes(1);

    bannerProps.onDismiss();
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("scopes the prompt hook to the landing toolbar's live selection and default-host client", () => {
    renderLandingComposer();
    const args = testState.promptArgs;
    if (args === null) throw new Error("expected prompt args");
    expect(args.harnessId).toBe("claude");
    expect(args.profileId).toBeNull();
    expect(args.selectedModel).toBe(testState.seededModel);
    expect(args.client).toBeNull();
    expect(args.active).toBe(true);
  });

  it("deactivates the prompt hook when the landing surface is not active", () => {
    testState.surfaceActive = false;
    renderLandingComposer();
    expect(testState.promptArgs?.active).toBe(false);
  });
});
