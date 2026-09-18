import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureSampleWorkspaceTab,
  exitCustomize,
} from "@/lib/customize/enter-exit";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { emptyTabStripLayout, tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { TabRef } from "@/stores/tabs/types";
import { SampleWorkspaceSurface } from "@/components/sample-workspace/sample-workspace-surface";

vi.mock("@/components/sample-workspace/sample-workspace-body", () => ({
  SampleWorkspaceBody: () => <div data-testid="sample-body" />,
}));

const SAMPLE_REF: TabRef = {
  kind: "sample-workspace",
  id: "sample-workspace",
};
const SAMPLE_ITEM_ID = tabItemId(SAMPLE_REF);
const EPIC_REF: TabRef = { kind: "epic", id: "tab-a" };
const EPIC_ITEM_ID = tabItemId(EPIC_REF);
const WIDE = 1280;
const NARROW = 500;

const originalWidth = window.innerWidth;

function setWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

// No explicit return type on purpose: the vi.fn mocks must stay assertable.
function fakeModalApi() {
  return {
    active: null,
    openSettings: vi.fn(),
    openHistory: vi.fn(),
    close: vi.fn(),
    setSection: vi.fn(),
    promoteToTab: vi.fn(),
    isOverlayActive: () => false,
  };
}

function sampleItemCount(): number {
  return useTabsStore
    .getState()
    .items.filter(
      (item) => item.kind === "tab" && item.ref.kind === "sample-workspace",
    ).length;
}

/** Epic tab + sample tab in the strip, `activeItemId` = the given item. */
function seedStrip(activeItemId: string | null): void {
  useTabsStore.setState({
    ...emptyTabStripLayout(),
    items: [
      { kind: "tab", id: EPIC_ITEM_ID, ref: EPIC_REF },
      { kind: "tab", id: SAMPLE_ITEM_ID, ref: SAMPLE_REF },
    ],
    activeItemId,
    stripOrder: [EPIC_REF, SAMPLE_REF],
  });
}

function activate(itemId: string): void {
  act(() => {
    useTabsStore.setState({ activeItemId: itemId });
  });
}

function session() {
  return useCustomizeStore.getState().session;
}

beforeEach(() => {
  localStorage.clear();
  setWidth(WIDE);
  useSettingsStore.setState({ visualLayoutEditorEnabled: true });
  useCustomizeStore.setState({
    session: null,
    instances: new Map(),
    history: { past: [], future: [] },
  });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  tabCommandCoordinator.resetReconciliationForTesting();
});

afterEach(() => {
  cleanup();
  if (useCustomizeStore.getState().session) exitCustomize("done");
  setSystemTabModalApi(null);
  useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
  setWidth(originalWidth);
  localStorage.clear();
});

describe("SampleWorkspaceSurface - session start", () => {
  it("starts a sample-scene session on mount when its tab is active", () => {
    seedStrip(SAMPLE_ITEM_ID);
    render(<SampleWorkspaceSurface tabId="sample-workspace" />);

    expect(session()?.scene).toBe("sample");
  });

  it("does not start a session while its tab is not the active item", () => {
    seedStrip(EPIC_ITEM_ID);
    render(<SampleWorkspaceSurface tabId="sample-workspace" />);

    expect(session()).toBeNull();
  });

  it("carries the opener passed to ensureSampleWorkspaceTab into the session", () => {
    const opener = {
      kind: "settings-modal",
      section: "layout",
      scrollTop: 12,
    } as const;
    setSystemTabModalApi(fakeModalApi());
    ensureSampleWorkspaceTab(opener);
    activate(SAMPLE_ITEM_ID);
    render(<SampleWorkspaceSurface tabId="sample-workspace" />);

    expect(session()?.opener).toEqual(opener);
  });
});

describe("SampleWorkspaceSurface - exits that close the tab", () => {
  it("done ends the session, removes the tab, and reopens the opener", async () => {
    const modal = fakeModalApi();
    setSystemTabModalApi(modal);
    ensureSampleWorkspaceTab({
      kind: "settings-modal",
      section: "layout",
      scrollTop: 0,
    });
    activate(SAMPLE_ITEM_ID);
    render(<SampleWorkspaceSurface tabId="sample-workspace" />);
    expect(session()).not.toBeNull();

    act(() => exitCustomize("done"));

    expect(session()).toBeNull();
    await waitFor(() => expect(sampleItemCount()).toBe(0));
    expect(modal.openSettings).toHaveBeenCalledWith({
      section: "layout",
      resetToGeneral: false,
    });
  });

  it("escape ends the session, removes the tab, and reopens the opener", async () => {
    const modal = fakeModalApi();
    setSystemTabModalApi(modal);
    ensureSampleWorkspaceTab({
      kind: "settings-modal",
      section: "layout",
      scrollTop: 0,
    });
    activate(SAMPLE_ITEM_ID);
    render(<SampleWorkspaceSurface tabId="sample-workspace" />);

    act(() => exitCustomize("escape"));

    expect(session()).toBeNull();
    await waitFor(() => expect(sampleItemCount()).toBe(0));
    expect(modal.openSettings).toHaveBeenCalledTimes(1);
  });

  it("done with no opener closes the tab and opens nothing", async () => {
    const modal = fakeModalApi();
    setSystemTabModalApi(modal);
    ensureSampleWorkspaceTab({ kind: "none" });
    activate(SAMPLE_ITEM_ID);
    render(<SampleWorkspaceSurface tabId="sample-workspace" />);

    act(() => exitCustomize("done"));

    await waitFor(() => expect(sampleItemCount()).toBe(0));
    expect(modal.openSettings).not.toHaveBeenCalled();
  });

  it("dropping below md ends the session and closes the tab without restoring the opener", async () => {
    const modal = fakeModalApi();
    setSystemTabModalApi(modal);
    ensureSampleWorkspaceTab({
      kind: "settings-modal",
      section: "layout",
      scrollTop: 0,
    });
    activate(SAMPLE_ITEM_ID);
    render(<SampleWorkspaceSurface tabId="sample-workspace" />);

    act(() => {
      setWidth(NARROW);
      window.dispatchEvent(new Event("resize"));
    });

    expect(session()).toBeNull();
    await waitFor(() => expect(sampleItemCount()).toBe(0));
    expect(modal.openSettings).not.toHaveBeenCalled();
  });

  it("turning the switch off ends the session and closes the tab", async () => {
    ensureSampleWorkspaceTab({ kind: "none" });
    activate(SAMPLE_ITEM_ID);
    render(<SampleWorkspaceSurface tabId="sample-workspace" />);

    act(() => {
      useSettingsStore.setState({ visualLayoutEditorEnabled: false });
    });

    expect(session()).toBeNull();
    await waitFor(() => expect(sampleItemCount()).toBe(0));
  });
});

describe("SampleWorkspaceSurface - tab-switch retains the tab", () => {
  it("switching to another tab ends the session but keeps the sample tab", () => {
    const modal = fakeModalApi();
    setSystemTabModalApi(modal);
    seedStrip(SAMPLE_ITEM_ID);
    render(<SampleWorkspaceSurface tabId="sample-workspace" />);
    expect(session()).not.toBeNull();

    activate(EPIC_ITEM_ID);

    expect(session()).toBeNull();
    expect(sampleItemCount()).toBe(1);
    expect(modal.openSettings).not.toHaveBeenCalled();
  });

  it("re-activating the tab starts a fresh sample session", () => {
    seedStrip(SAMPLE_ITEM_ID);
    render(<SampleWorkspaceSurface tabId="sample-workspace" />);
    activate(EPIC_ITEM_ID);
    expect(session()).toBeNull();

    activate(SAMPLE_ITEM_ID);

    expect(session()?.scene).toBe("sample");
  });
});

describe("SampleWorkspaceSurface - unmount", () => {
  it("unmount ends the session (studio-closed) without restoring the opener", () => {
    const modal = fakeModalApi();
    setSystemTabModalApi(modal);
    ensureSampleWorkspaceTab({
      kind: "settings-modal",
      section: "layout",
      scrollTop: 0,
    });
    activate(SAMPLE_ITEM_ID);
    const view = render(<SampleWorkspaceSurface tabId="sample-workspace" />);
    expect(session()).not.toBeNull();

    view.unmount();

    expect(session()).toBeNull();
    expect(modal.openSettings).not.toHaveBeenCalled();
  });

  it("unmount alone does not remove the tab", () => {
    seedStrip(SAMPLE_ITEM_ID);
    const view = render(<SampleWorkspaceSurface tabId="sample-workspace" />);

    view.unmount();

    expect(sampleItemCount()).toBe(1);
  });
});
