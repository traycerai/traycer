/**
 * `useHeaderTabAppearance` picks a tab's {hostId, workspacePath} source and
 * folds `useWorkspaceAppearance` (real RPC/cache chain covered by
 * `use-header-tab-appearance-session-continuity.test.tsx` and
 * `use-workspace-appearance.test.tsx`) into `repositoryIdentity`. Fakes that
 * layer here to isolate the source-selection and assembly wiring itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { clearSessionCreatedEpics } from "@/lib/epics/session-created-epics";
import {
  EMPTY_LANDING_DRAFT_CONTENT,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import type { AppearanceScope } from "@/lib/appearance/appearance-cache";
import type {
  HeaderTab,
  HeaderTabRepositoryIdentity,
} from "@/stores/tabs/types";
import { useHeaderTabAppearance } from "../use-header-tab-appearance";

const mocks = vi.hoisted(() => ({
  useEpicAppearanceSource: vi.fn(),
  useWorkspaceAppearance: vi.fn(),
  useComposerPlacement: vi.fn(),
}));

vi.mock("@/hooks/appearance/use-workspace-appearance", () => ({
  useEpicAppearanceSource: mocks.useEpicAppearanceSource,
  useWorkspaceAppearance: mocks.useWorkspaceAppearance,
}));
// Only the composer-host boundary is faked for the draft path; the store and
// `resolvePrimaryPath` wiring inside `useLandingDraftAppearanceSource` run for
// real, so a missing draft / a changed primary path are genuinely exercised.
vi.mock("@/hooks/host/use-composer-placement", () => ({
  useComposerPlacement: mocks.useComposerPlacement,
}));

interface FakeResolved {
  readonly appearance: {
    readonly appearance: {
      readonly color: string;
      readonly icon?: HeaderTabRepositoryIdentity["icon"];
    };
    readonly invalidFields: readonly ("color" | "icon")[];
  } | null;
  readonly scope: AppearanceScope | null;
  readonly assetRefreshKey: number;
}

function resolved(
  color: string,
  scope: AppearanceScope | null,
  assetRefreshKey: number,
): FakeResolved {
  return {
    appearance: { appearance: { color }, invalidFields: [] },
    scope,
    assetRefreshKey,
  };
}

function neutral(): FakeResolved {
  return { appearance: null, scope: null, assetRefreshKey: 1 };
}

function scopeFor(root: string): AppearanceScope {
  return { accountId: "acct-1", hostId: "host-a", canonicalSourceRoot: root };
}

function placement(hostId: string | null): void {
  mocks.useComposerPlacement.mockReturnValue({
    target: { resolvedHostId: hostId },
  });
}

function draftWorkspace(
  folders: readonly string[],
  primaryPath: string | null,
) {
  return { folders, folderInfoByPath: {}, primaryPath };
}

function seedDraft(
  id: string,
  folders: readonly string[],
  primaryPath: string | null,
) {
  return {
    id,
    content: EMPTY_LANDING_DRAFT_CONTENT,
    selection: null,
    lastTouchedAt: 0,
    settings: null,
    composerMode: "chat" as const,
    workspace: draftWorkspace(folders, primaryPath),
  };
}

function epicTab(args: {
  epicId: string;
  hostId: string | null;
}): Extract<HeaderTab, { kind: "epic" }> {
  return {
    kind: "epic",
    id: args.epicId,
    epicId: args.epicId,
    hostId: args.hostId,
    route: "/x",
    name: "Task",
    icon: null,
    canClose: true,
    canDuplicate: true,
    canOpenInNewWindow: true,
    repositoryIdentity: null,
  };
}

function draftTab(id: string): Extract<HeaderTab, { kind: "draft" }> {
  return {
    kind: "draft",
    id,
    route: "/d",
    name: "Start Page",
    icon: null,
    canDuplicate: false,
    canOpenInNewWindow: true,
    repositoryIdentity: null,
  };
}

function repositoryIdentityOf(
  tab: HeaderTab | null | undefined,
): HeaderTabRepositoryIdentity | null {
  if (tab === null || tab === undefined) return null;
  return tab.kind === "epic" || tab.kind === "draft"
    ? tab.repositoryIdentity
    : null;
}

function settingsTab(): Extract<HeaderTab, { kind: "settings" }> {
  return {
    kind: "settings",
    id: "settings",
    route: "/settings",
    name: "Settings",
    icon: null,
    canDuplicate: false,
    canOpenInNewWindow: false,
    lastPath: null,
  };
}

// `useHeaderTabAppearance` calls both source hooks unconditionally (rules of
// hooks), regardless of tab kind - every test needs a safe default for
// whichever source it isn't exercising, or the untouched one destructures
// `undefined`.
beforeEach(() => {
  mocks.useComposerPlacement.mockReturnValue({
    target: { resolvedHostId: null },
  });
  mocks.useEpicAppearanceSource.mockReturnValue({
    hostId: null,
    workspacePath: null,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  clearSessionCreatedEpics();
  useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
  useWorkspaceFoldersStore.setState(
    useWorkspaceFoldersStore.getInitialState(),
    true,
  );
});

describe("useHeaderTabAppearance: epic source passthrough", () => {
  it("passes the epic's own {hostId, epicId} straight through to useEpicAppearanceSource - no fallback applied here", () => {
    mocks.useEpicAppearanceSource.mockReturnValue({
      hostId: null,
      workspacePath: null,
    });
    mocks.useWorkspaceAppearance.mockReturnValue(neutral());

    renderHook(() =>
      useHeaderTabAppearance(epicTab({ epicId: "epic-cold", hostId: null })),
    );

    expect(mocks.useEpicAppearanceSource).toHaveBeenCalledWith({
      hostId: null,
      epicId: "epic-cold",
    });
  });
});

describe("useHeaderTabAppearance: draft source (real store + real resolvePrimaryPath, only the composer host mocked)", () => {
  it("resolves EMPTY folders/null primary for a draft id that isn't in the store, even when a global folders bucket exists for that host", () => {
    placement("host-a");
    useWorkspaceFoldersStore.setState({
      byHost: {
        "host-a": {
          folders: ["/global"],
          folderInfoByPath: {},
          primaryPath: "/global",
        },
      },
    });
    mocks.useWorkspaceAppearance.mockImplementation(
      (args: { workspacePath: string | null }) => {
        expect(args.workspacePath).toBeNull();
        return neutral();
      },
    );

    renderHook(() => useHeaderTabAppearance(draftTab("draft-missing")));

    expect(mocks.useWorkspaceAppearance).toHaveBeenCalledWith({
      hostId: "host-a",
      workspacePath: null,
    });
  });

  it("resolves two real drafts' identity from their own workspace snapshot, with no cross-bleed", () => {
    placement("host-a");
    useLandingDraftStore.setState({
      drafts: [
        seedDraft("draft-a", ["/repo-a"], "/repo-a"),
        seedDraft("draft-b", ["/repo-b"], "/repo-b"),
      ],
    });
    mocks.useWorkspaceAppearance.mockImplementation(
      (args: { workspacePath: string | null }) => {
        if (args.workspacePath === "/repo-a")
          return resolved("#111111", scopeFor("/repo-a"), 1);
        if (args.workspacePath === "/repo-b")
          return resolved("#222222", scopeFor("/repo-b"), 1);
        return neutral();
      },
    );

    const a = renderHook(() => useHeaderTabAppearance(draftTab("draft-a")));
    const b = renderHook(() => useHeaderTabAppearance(draftTab("draft-b")));

    expect(repositoryIdentityOf(a.result.current)?.color).toBe("#111111");
    expect(repositoryIdentityOf(b.result.current)?.color).toBe("#222222");
  });

  it("updates only the draft whose primary folder actually changed, via the real setDraftWorkspacePrimary action", () => {
    placement("host-a");
    // Both candidate folders are present from the start - the store action
    // under test only ever moves `primaryPath` between them, never touches
    // `folders`, so a color change here can only come from the primary flip.
    useLandingDraftStore.setState({
      drafts: [
        seedDraft("draft-a", ["/repo-a", "/repo-a-2"], "/repo-a"),
        seedDraft("draft-b", ["/repo-b"], "/repo-b"),
      ],
    });
    mocks.useWorkspaceAppearance.mockImplementation(
      (args: { workspacePath: string | null }) => {
        if (args.workspacePath === "/repo-a")
          return resolved("#111111", scopeFor("/repo-a"), 1);
        if (args.workspacePath === "/repo-a-2")
          return resolved("#333333", scopeFor("/repo-a-2"), 1);
        if (args.workspacePath === "/repo-b")
          return resolved("#222222", scopeFor("/repo-b"), 1);
        return neutral();
      },
    );

    const a = renderHook(() => useHeaderTabAppearance(draftTab("draft-a")));
    const b = renderHook(() => useHeaderTabAppearance(draftTab("draft-b")));
    expect(repositoryIdentityOf(a.result.current)?.color).toBe("#111111");
    expect(repositoryIdentityOf(b.result.current)?.color).toBe("#222222");

    act(() => {
      useLandingDraftStore
        .getState()
        .setDraftWorkspacePrimary("draft-a", "/repo-a-2");
    });

    expect(repositoryIdentityOf(a.result.current)?.color).toBe("#333333");
    // Untouched draft's own resolution is unaffected by the other's primary change.
    expect(repositoryIdentityOf(b.result.current)?.color).toBe("#222222");
  });
});

describe("useHeaderTabAppearance: rejected icon issue", () => {
  it("projects iconRejected:true from an 'icon' issue while retaining the image icon config", () => {
    mocks.useEpicAppearanceSource.mockReturnValue({
      hostId: "host-a",
      workspacePath: "/repo",
    });
    mocks.useWorkspaceAppearance.mockReturnValue({
      appearance: {
        appearance: {
          color: "#445566",
          icon: { kind: "image", path: "appearance/logo.webp" },
        },
        invalidFields: ["icon"],
      },
      scope: scopeFor("/repo"),
      assetRefreshKey: 1,
    });
    const tab = epicTab({ epicId: "epic-rejected", hostId: "host-a" });

    const { result } = renderHook(() => useHeaderTabAppearance(tab));

    expect(repositoryIdentityOf(result.current)?.iconRejected).toBe(true);
    expect(repositoryIdentityOf(result.current)?.icon).toEqual({
      kind: "image",
      path: "appearance/logo.webp",
    });
  });
});

describe("useHeaderTabAppearance: neutral passthrough", () => {
  it("returns the exact same tab reference when neither color nor icon resolved", () => {
    mocks.useEpicAppearanceSource.mockReturnValue({
      hostId: null,
      workspacePath: null,
    });
    mocks.useWorkspaceAppearance.mockReturnValue(neutral());
    const tab = epicTab({ epicId: "epic-neutral", hostId: "host-a" });

    const { result } = renderHook(() => useHeaderTabAppearance(tab));

    expect(result.current).toBe(tab);
    expect(repositoryIdentityOf(result.current)).toBeNull();
  });

  it("passes a non-draft/epic tab through unchanged", () => {
    mocks.useEpicAppearanceSource.mockReturnValue({
      hostId: null,
      workspacePath: null,
    });
    mocks.useWorkspaceAppearance.mockReturnValue(neutral());
    const tab = settingsTab();

    const { result } = renderHook(() => useHeaderTabAppearance(tab));

    expect(result.current).toBe(tab);
  });

  it("passes a null tab through as null", () => {
    mocks.useEpicAppearanceSource.mockReturnValue({
      hostId: null,
      workspacePath: null,
    });
    mocks.useWorkspaceAppearance.mockReturnValue(neutral());

    const { result } = renderHook(() => useHeaderTabAppearance(null));

    expect(result.current).toBeNull();
  });
});
