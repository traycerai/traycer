import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { SampleWorkspaceSurface } from "@/components/sample-workspace/sample-workspace-surface";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  ensureSampleWorkspaceTab,
  exitCustomize,
} from "@/lib/customize/enter-exit";
import { readCustomizeLease } from "@/lib/customize/lease";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { emptyTabStripLayout, tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { TabRef } from "@/stores/tabs/types";

vi.mock("@/components/sample-workspace/sample-workspace-body", () => ({
  SampleWorkspaceBody: () => <div data-testid="sample-body" />,
}));

const leaseCalls = vi.hoisted(() => ({
  acquire: vi.fn<() => boolean>(),
  release: vi.fn<() => void>(),
}));
vi.mock("@/lib/customize/lease", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/customize/lease")>();
  leaseCalls.acquire.mockImplementation(actual.acquireCustomizeLease);
  leaseCalls.release.mockImplementation(actual.releaseCustomizeLease);
  return {
    ...actual,
    acquireCustomizeLease: leaseCalls.acquire,
    releaseCustomizeLease: leaseCalls.release,
  };
});

const EPIC_REF: TabRef = { kind: "epic", id: "tab-a" };
const SAMPLE_REF: TabRef = { kind: "sample-workspace", id: "sample-workspace" };
const EPIC_ITEM_ID = tabItemId(EPIC_REF);
const SAMPLE_ITEM_ID = tabItemId(SAMPLE_REF);

let track: MockInstance<Analytics["track"]>;

function openedEvents(): number {
  return track.mock.calls.filter(
    (call) => call[0] === AnalyticsEvent.LayoutEditorOpened,
  ).length;
}

function sampleTabCount(): number {
  return useTabsStore
    .getState()
    .items.filter(
      (item) => item.kind === "tab" && item.ref.kind === "sample-workspace",
    ).length;
}

function seed(activeItemId: string): void {
  useTabsStore.setState({
    ...emptyTabStripLayout(),
    items: [{ kind: "tab", id: EPIC_ITEM_ID, ref: EPIC_REF }],
    activeItemId: EPIC_ITEM_ID,
    stripOrder: [EPIC_REF],
  });
  ensureSampleWorkspaceTab({ kind: "none" });
  useTabsStore.setState({ activeItemId });
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderStrict() {
  return render(
    <StrictMode>
      <SampleWorkspaceSurface tabId="sample-workspace" />
    </StrictMode>,
  );
}

beforeEach(() => {
  localStorage.clear();
  leaseCalls.acquire.mockClear();
  leaseCalls.release.mockClear();
  track = vi.spyOn(Analytics.getInstance(), "track").mockReturnValue(false);
  useSettingsStore.setState({ visualLayoutEditorEnabled: true });
  useCustomizeStore.setState({ session: null, instances: new Map() });
  tabCommandCoordinator.resetReconciliationForTesting();
});

afterEach(() => {
  cleanup();
  if (useCustomizeStore.getState().session) exitCustomize("done");
  useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
  track.mockRestore();
  localStorage.clear();
});

describe("S3 - StrictMode activation is one logical entry", () => {
  it("acquires the lease once, never releases it, and emits one LayoutEditorOpened", async () => {
    seed(SAMPLE_ITEM_ID);

    renderStrict();
    await flushMicrotasks();

    expect(useCustomizeStore.getState().session?.scene).toBe("sample");
    expect(leaseCalls.acquire).toHaveBeenCalledTimes(1);
    expect(leaseCalls.release).not.toHaveBeenCalled();
    expect(openedEvents()).toBe(1);
    expect(readCustomizeLease()).not.toBeNull();
  });

  it("keeps ONE session object across the probe (no clear/recreate churn)", async () => {
    seed(SAMPLE_ITEM_ID);
    const seen: unknown[] = [];
    const unsubscribe = useCustomizeStore.subscribe((state) => {
      if (state.session !== null && !seen.includes(state.session)) {
        seen.push(state.session);
      }
    });

    renderStrict();
    await flushMicrotasks();
    unsubscribe();

    expect(seen).toHaveLength(1);
  });

  it("an inactive sample tab starts nothing, even under StrictMode", async () => {
    seed(EPIC_ITEM_ID);

    renderStrict();
    await flushMicrotasks();

    expect(useCustomizeStore.getState().session).toBeNull();
    expect(leaseCalls.acquire).not.toHaveBeenCalled();
    expect(openedEvents()).toBe(0);
  });
});

describe("S3 - a REAL exit still cleans up", () => {
  it("unmounting ends the session and releases the lease exactly once", async () => {
    seed(SAMPLE_ITEM_ID);
    const view = renderStrict();
    await flushMicrotasks();
    expect(readCustomizeLease()).not.toBeNull();

    view.unmount();
    await flushMicrotasks();

    expect(useCustomizeStore.getState().session).toBeNull();
    expect(leaseCalls.release).toHaveBeenCalledTimes(1);
    expect(readCustomizeLease()).toBeNull();
  });

  it("Done closes the tab, releases once, and the still-mounted surface does not re-enter", async () => {
    seed(SAMPLE_ITEM_ID);
    renderStrict();
    await flushMicrotasks();

    act(() => exitCustomize("done"));
    await flushMicrotasks();

    expect(useCustomizeStore.getState().session).toBeNull();
    expect(sampleTabCount()).toBe(0);
    expect(leaseCalls.release).toHaveBeenCalledTimes(1);
    expect(leaseCalls.acquire).toHaveBeenCalledTimes(1);
    expect(openedEvents()).toBe(1);
  });

  it("switching away ends the session; switching back is a NEW activation with its own event", async () => {
    seed(SAMPLE_ITEM_ID);
    renderStrict();
    await flushMicrotasks();

    act(() => {
      useTabsStore.setState({ activeItemId: EPIC_ITEM_ID });
    });
    await flushMicrotasks();
    expect(useCustomizeStore.getState().session).toBeNull();
    expect(sampleTabCount()).toBe(1);
    expect(leaseCalls.release).toHaveBeenCalledTimes(1);

    act(() => {
      useTabsStore.setState({ activeItemId: SAMPLE_ITEM_ID });
    });
    await flushMicrotasks();

    expect(useCustomizeStore.getState().session?.scene).toBe("sample");
    expect(leaseCalls.acquire).toHaveBeenCalledTimes(2);
    expect(openedEvents()).toBe(2);
  });

  it("an immediate unmount + replacement mount (before the microtask) keeps ONE logical session", async () => {
    seed(SAMPLE_ITEM_ID);
    const first = render(<SampleWorkspaceSurface tabId="sample-workspace" />);
    const sessionBefore = useCustomizeStore.getState().session;
    expect(sessionBefore?.scene).toBe("sample");

    // A different component instance takes over in the same tick, e.g. the
    // host re-keying the surface. No await in between.
    first.unmount();
    render(<SampleWorkspaceSurface tabId="sample-workspace" />);
    await flushMicrotasks();

    expect(useCustomizeStore.getState().session).toBe(sessionBefore);
    expect(leaseCalls.acquire).toHaveBeenCalledTimes(1);
    expect(leaseCalls.release).not.toHaveBeenCalled();
    expect(openedEvents()).toBe(1);
  });

  it("after such a replacement, the replacement's REAL unmount still cleans up", async () => {
    seed(SAMPLE_ITEM_ID);
    const first = render(<SampleWorkspaceSurface tabId="sample-workspace" />);
    first.unmount();
    const second = render(<SampleWorkspaceSurface tabId="sample-workspace" />);
    await flushMicrotasks();

    second.unmount();
    await flushMicrotasks();

    expect(useCustomizeStore.getState().session).toBeNull();
    expect(leaseCalls.release).toHaveBeenCalledTimes(1);
  });

  it("a stale deferred cleanup never releases a DIFFERENT session", async () => {
    seed(SAMPLE_ITEM_ID);
    const view = render(<SampleWorkspaceSurface tabId="sample-workspace" />);
    view.unmount();
    // Before the microtask runs, the session is ended and a new one begun by
    // some other path (tab-switch away and back through the store).
    act(() => {
      exitCustomize("tab-switch");
    });
    leaseCalls.release.mockClear();
    render(<SampleWorkspaceSurface tabId="sample-workspace" />);
    await flushMicrotasks();
    const live = useCustomizeStore.getState().session;

    await flushMicrotasks();

    expect(live?.scene).toBe("sample");
    expect(useCustomizeStore.getState().session).toBe(live);
    expect(leaseCalls.release).not.toHaveBeenCalled();
  });

  it("without StrictMode the counts are identical (the fix must not change the plain path)", async () => {
    seed(SAMPLE_ITEM_ID);
    const view = render(<SampleWorkspaceSurface tabId="sample-workspace" />);
    await flushMicrotasks();

    expect(leaseCalls.acquire).toHaveBeenCalledTimes(1);
    expect(openedEvents()).toBe(1);

    view.unmount();
    await flushMicrotasks();
    expect(useCustomizeStore.getState().session).toBeNull();
    expect(leaseCalls.release).toHaveBeenCalledTimes(1);
  });
});
