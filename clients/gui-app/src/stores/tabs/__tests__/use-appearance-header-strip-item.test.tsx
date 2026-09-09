/**
 * `useAppearanceHeaderStripItem` folds `useHeaderTabAppearance` onto real
 * `useHeaderStripItem` output. Fakes only the appearance source/RPC layer;
 * proves a mixed-project split resolves each member independently, and a
 * real duplicate view of the same epic resolves to an equal identity.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { duplicateEpicTab } from "@/lib/commands/actions/duplicate-tab";
import { useAppearanceHeaderStripItem } from "@/stores/tabs/use-header-tabs";
import type { HeaderStripItem } from "@/stores/tabs/use-header-tabs";
import { tabRepositoryIdentity } from "@/stores/tabs/types";

const mocks = vi.hoisted(() => ({
  useEpicAppearanceSource: vi.fn(),
  useWorkspaceAppearance: vi.fn(),
}));

vi.mock("@/hooks/appearance/use-workspace-appearance", () => ({
  useEpicAppearanceSource: mocks.useEpicAppearanceSource,
  useWorkspaceAppearance: mocks.useWorkspaceAppearance,
}));
vi.mock("@/hooks/appearance/use-landing-draft-appearance", () => ({
  useLandingDraftAppearanceSource: () => ({
    hostId: null,
    folders: [],
    primaryPath: null,
  }),
}));

function resetStores(): void {
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
  getOpenEpicRegistry().disposeAll();
}

/** One shared epicId -> workspacePath mapping, installed once per test. */
function installEpicSourceMap(byEpicId: ReadonlyMap<string, string>): void {
  mocks.useEpicAppearanceSource.mockImplementation(
    (args: { epicId: string }) => {
      const workspacePath = byEpicId.get(args.epicId);
      return workspacePath === undefined
        ? { hostId: null, workspacePath: null }
        : { hostId: "host-a", workspacePath };
    },
  );
}

function seedSplit(leftTabId: string, rightTabId: string): string {
  const splitId = "split-1";
  useTabsStore.setState({
    items: [
      {
        kind: "split",
        id: splitId,
        left: { kind: "tab", ref: { kind: "epic", id: leftTabId } },
        right: { kind: "tab", ref: { kind: "epic", id: rightTabId } },
        focusedSide: "left",
        routeBackingSide: "left",
        leftRatio: 0.5,
      },
    ],
  });
  return splitId;
}

function scopeFor(root: string) {
  return { accountId: "acct-1", hostId: "host-a", canonicalSourceRoot: root };
}

function appearanceResultFor(color: string, root: string) {
  return {
    appearance: {
      canonicalSourceRoot: root,
      status: "present" as const,
      revision: "r",
      appearance: { version: 1 as const, color },
      invalidFields: [],
      messages: [],
      editable: true,
      assetRefreshKey: 1,
    },
    scope: scopeFor(root),
    assetRefreshKey: 1,
  };
}

function memberColor(
  item: HeaderStripItem | null,
  side: "left" | "right",
): string | null | undefined {
  if (item === null || item.kind !== "split") return undefined;
  const member = side === "left" ? item.left : item.right;
  return member.kind === "tab"
    ? tabRepositoryIdentity(member.tab)?.color
    : undefined;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetStores();
});

describe("useAppearanceHeaderStripItem: mixed-project split", () => {
  it("resolves each split member's identity independently, with no bleed across the pair", () => {
    resetStores();
    const leftTabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-left", "Left");
    const rightTabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-right", "Right");
    installEpicSourceMap(
      new Map([
        ["epic-left", "/repo-left"],
        ["epic-right", "/repo-right"],
      ]),
    );
    const splitId = seedSplit(leftTabId, rightTabId);
    mocks.useWorkspaceAppearance.mockImplementation(
      (args: { workspacePath: string | null }) => {
        if (args.workspacePath === null)
          return { appearance: null, scope: null, assetRefreshKey: 1 };
        if (args.workspacePath === "/repo-left")
          return appearanceResultFor("#111111", "/repo-left");
        if (args.workspacePath === "/repo-right")
          return appearanceResultFor("#222222", "/repo-right");
        throw new Error(`unexpected workspacePath ${args.workspacePath}`);
      },
    );

    const { result } = renderHook(() => useAppearanceHeaderStripItem(splitId));

    expect(memberColor(result.current, "left")).toBe("#111111");
    expect(memberColor(result.current, "right")).toBe("#222222");
  });
});

describe("useAppearanceHeaderStripItem: a real duplicate view resolves to an equal identity", () => {
  it("gives a tab and its real duplicate (same epicId, new tabId) an equal repositoryIdentity", () => {
    resetStores();
    const epicId = "epic-original";
    const originalTabId = useEpicCanvasStore
      .getState()
      .openEpicTab(epicId, "Original");
    installEpicSourceMap(new Map([[epicId, "/repo-same"]]));
    mocks.useWorkspaceAppearance.mockImplementation(
      (args: { workspacePath: string | null }) => {
        if (args.workspacePath === null)
          return { appearance: null, scope: null, assetRefreshKey: 1 };
        if (args.workspacePath === "/repo-same")
          return appearanceResultFor("#334455", "/repo-same");
        throw new Error(`unexpected workspacePath ${args.workspacePath}`);
      },
    );
    const duplicated = duplicateEpicTab(originalTabId);
    if (duplicated === null)
      throw new Error("expected duplicateEpicTab to succeed");
    expect(duplicated.epicId).toBe(epicId);
    // `seedSplit` accepts identical ids and the appearance hook would then
    // resolve both members to the same identity regardless, so a regression
    // that made `duplicateEpicTab` return `originalTabId` would still pass
    // both color assertions below unless this is checked directly.
    expect(duplicated.tabId).not.toBe(originalTabId);
    const splitId = seedSplit(originalTabId, duplicated.tabId);

    const { result } = renderHook(() => useAppearanceHeaderStripItem(splitId));

    expect(memberColor(result.current, "left")).toBe("#334455");
    expect(memberColor(result.current, "right")).toBe("#334455");
  });
});
