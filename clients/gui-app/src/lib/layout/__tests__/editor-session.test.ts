import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  abandonLayoutEditorSession,
  closeLayoutEditor,
  closeLayoutEditorForCloseTabChord,
  openLayoutEditor,
  type LayoutEditorExitReason,
} from "@/lib/layout/editor-session";
import { setLayoutInspectorNode } from "@/lib/layout/editor-motion";
import {
  installFakeViewTransitions,
  type FakeViewTransition,
} from "@/lib/layout/test-support/fake-view-transition";
import {
  LAYOUT_EDITOR_LEASE_KEY,
  readLayoutEditorLease,
} from "@/lib/layout/editor-lease";
import { LAYOUT_EDITOR_MIN_WIDTH } from "@/lib/layout/editor-width";
import { emptyTabStripLayout, tabItemId } from "@/stores/tabs/layout";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import type { SystemModalActive } from "@/stores/tabs/system-overlay-types";
import { useCommandPaletteStore } from "@/stores/command-palette/command-palette-store";
import type { SurfaceGroupId } from "@/components/layout-editor/regions/region-grammar";
import {
  useLayoutEditorStore,
  type LayoutEditorOrigin,
} from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  getLayoutSnapshot,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { useTabsStore } from "@/stores/tabs/store";
import type { RegionId } from "@/lib/layout/region-id";
import type { TabRef } from "@/stores/tabs/types";

const navigation = vi.hoisted(() => ({
  navigateToSettingsSection: vi.fn(),
  navigateToLayoutArea: vi.fn(),
}));
const toasts = vi.hoisted(() => ({ info: vi.fn() }));
// The door's only two toasts are `info`; a namespace-only mock would make an
// unexpected call throw rather than fail an assertion.
vi.mock("sonner", () => ({ toast: { info: toasts.info } }));
vi.mock("@/lib/settings-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings-navigation")>()),
  navigateToSettingsSection: navigation.navigateToSettingsSection,
  // Mocked alongside its sibling rather than spied on separately: the door
  // calls it by its own name, but `navigateToLayoutArea`'s own body calls
  // `navigateToSettingsSection` through the SAME module's closure, not
  // through this mocked export object - so overriding only the section
  // navigator would leave the area navigator on its real implementation,
  // which needs a published modal API this suite never stands up.
  navigateToLayoutArea: navigation.navigateToLayoutArea,
}));

/**
 * The door, driven the way a pointer entry actually drives it.
 *
 * `document.startViewTransition` is installed for the whole suite, so every
 * `open` and `close` below takes the production branch: the session change is
 * deferred into the transition's update callback rather than landing inside the
 * call. A suite without it reads `session` straight after `open(...)` and
 * passes for a reason that does not exist in a browser - which is exactly how
 * the re-open-during-exit race got through gate 1.
 *
 * The three cases that are ABOUT the guarded fallback turn a real guard on
 * (`data-reduce-panel-motion`) rather than uninstalling the API.
 */
const navigateToTabIntent = vi.fn();
let transitions: Array<FakeViewTransition> = [];
let uninstallViewTransitions: () => void = () => undefined;
const HISTORY_REF: TabRef = { kind: "history", id: "history" };
const EPIC_REF: TabRef = { kind: "epic", id: "tab-a" };
const SAMPLE_REF: TabRef = { kind: "sample-workspace", id: "sample-workspace" };

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

/**
 * Every update callback the browser has queued, in the order it would run
 * them: starting a transition skips the one already running, and a skipped
 * transition's callback is a task ahead of the new one's.
 */
function drainTransitions(): void {
  while (transitions.length > 0) transitions.shift()?.runUpdate();
}

function open(target: RegionId | null): boolean {
  return openWithOrigin({ kind: "tab" }, target);
}

/** Opened from a named origin, for the exit-return tests (5.3). */
function openWithOrigin(
  origin: LayoutEditorOrigin,
  target: RegionId | null,
): boolean {
  // The door takes a `navigateToTabIntent` callback because the
  // sample-workspace fallback is a real tab, activated through the ordinary
  // tab navigation controller; every other path ignores it.
  const opened = openLayoutEditor({
    source: "direct_ui",
    entry: "pointer",
    target,
    origin,
    navigateToTabIntent,
  });
  drainTransitions();
  return opened;
}

/** Leaving, then the frame the view transition defers the teardown to. */
function close(reason: LayoutEditorExitReason): void {
  closeLayoutEditor(reason);
  drainTransitions();
}

/**
 * The guard that puts both halves of the door on the fallback branch, which is
 * the only branch the inspector's own slide-out exists on.
 */
function forceReducedMotion(): void {
  document.documentElement.setAttribute("data-reduce-panel-motion", "");
}

/**
 * The modal bridge as `SystemTabModalHost` publishes it, with `active` set to
 * whichever overlay is up.
 */
function publishModalApi(active: SystemModalActive | null): {
  readonly close: Mock<() => void>;
} {
  const close = vi.fn();
  setSystemTabModalApi({
    active,
    openSettings: vi.fn(),
    openHistory: vi.fn(),
    close,
    setSection: vi.fn(),
    promoteToTab: vi.fn(),
    isOverlayActive: (kind) => active?.kind === kind,
  });
  return { close };
}

/**
 * The inspector as the fallback exit finds it: on screen, with an exit
 * animation still playing. jsdom runs no animations at all, so a suite that
 * does not stand one up can only ever see the immediate teardown.
 */
function mountAnimatedInspector(): { readonly finishSlideOut: () => void } {
  const inspector = document.createElement("div");
  inspector.setAttribute("data-layout-inspector", "");
  document.body.append(inspector);
  let settle: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });
  Object.defineProperty(inspector, "getAnimations", {
    configurable: true,
    writable: true,
    value: () => [{ finished }],
  });
  // The shell's ref callback is how the door learns which element to animate.
  setLayoutInspectorNode(inspector);
  return { finishSlideOut: settle };
}

/** A macrotask tick, which drains every pending microtask chain. */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function sampleTabPresent(): boolean {
  return useTabsStore
    .getState()
    .items.some(
      (item) => item.kind === "tab" && item.ref.kind === "sample-workspace",
    );
}

beforeEach(() => {
  const installed = installFakeViewTransitions();
  transitions = installed.transitions;
  uninstallViewTransitions = installed.uninstall;
  window.localStorage.clear();
  navigation.navigateToSettingsSection.mockReset();
  navigation.navigateToLayoutArea.mockReset();
  // The redirect reaches a Settings surface unless a test says otherwise; the
  // door only speaks up when it does not.
  navigation.navigateToSettingsSection.mockReturnValue(true);
  toasts.info.mockReset();
  navigateToTabIntent.mockReset();
  publishModalApi(null);
  useCommandPaletteStore.setState({ open: false });
  setViewportWidth(1440);
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  useLayoutEditorStore.getState().endSession();
  useTabsStore.setState({
    ...emptyTabStripLayout(),
    items: [{ kind: "tab", id: tabItemId(HISTORY_REF), ref: HISTORY_REF }],
    activeItemId: tabItemId(HISTORY_REF),
    stripOrder: [HISTORY_REF],
  });
});

afterEach(() => {
  // The motionless teardown, so nothing is left waiting on a transition this
  // suite never settles and no teardown survives into the next test.
  abandonLayoutEditorSession();
  setSystemTabModalApi(null);
  setLayoutInspectorNode(null);
  uninstallViewTransitions();
  transitions.length = 0;
  document.documentElement.removeAttribute("data-reduce-panel-motion");
  document.documentElement.removeAttribute("data-layout-transition");
  document.body.replaceChildren();
  useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
  // `Analytics.getInstance()` is a module-level singleton, so a
  // `vi.spyOn(..., "track")` left standing would keep accumulating calls
  // across every later test in this file.
  vi.restoreAllMocks();
});

describe("the width gate (L-02, 5.1)", () => {
  it("opens the full-width form instead of a session on a narrow window", () => {
    setViewportWidth(700);

    expect(open(null)).toBe(false);

    expect(useLayoutEditorStore.getState().session).toBeNull();
    expect(navigation.navigateToSettingsSection).toHaveBeenCalledWith("layout");
    expect(toasts.info).not.toHaveBeenCalled();
    // Nothing was claimed on the way out: another window can still open it.
    expect(window.localStorage.getItem(LAYOUT_EDITOR_LEASE_KEY)).toBeNull();
  });

  it("says so when there is no Settings surface to redirect into", () => {
    // Before the modal bridge publishes an API - a cold launch behind
    // `HostReadyGate` - the redirect reaches nothing, and the press would
    // otherwise be silently dead.
    navigation.navigateToSettingsSection.mockReturnValue(false);
    setViewportWidth(700);

    expect(open(null)).toBe(false);

    expect(toasts.info).toHaveBeenCalledOnce();
  });

  it("turns on 1100px exactly, and on no other number (L-64)", () => {
    // The number is the point. A gate asserted only at 700px passes just as
    // well on the 768px mobile breakpoint three surfaces used to read for
    // this, which is the bug L-64 settles: the editor opened into a 900px
    // window with no room for either half of itself.
    expect(LAYOUT_EDITOR_MIN_WIDTH).toBe(1100);

    setViewportWidth(LAYOUT_EDITOR_MIN_WIDTH - 1);
    expect(open(null)).toBe(false);
    expect(useLayoutEditorStore.getState().session).toBeNull();

    setViewportWidth(LAYOUT_EDITOR_MIN_WIDTH);
    expect(open(null)).toBe(true);
    expect(useLayoutEditorStore.getState().session).not.toBeNull();
  });

  it("holds a live session open at the threshold and drops it one pixel below", () => {
    open(null);

    setViewportWidth(LAYOUT_EDITOR_MIN_WIDTH);
    window.dispatchEvent(new Event("resize"));
    expect(useLayoutEditorStore.getState().session).not.toBeNull();

    setViewportWidth(LAYOUT_EDITOR_MIN_WIDTH - 1);
    window.dispatchEvent(new Event("resize"));
    expect(useLayoutEditorStore.getState().leaving).toBe(true);

    drainTransitions();
    expect(useLayoutEditorStore.getState().session).toBeNull();
  });
});

describe("the canvas (L-87, 5.1)", () => {
  it("opens the sample workspace, whatever the user was doing", () => {
    // The user's own task tab used to BE the canvas (L-15). L-87 takes that
    // away: the user's own task is never rearranged under them, so the same
    // gesture opens the sample tab here and with nothing open at all.
    useTabsStore.setState((state) => ({
      items: [
        ...state.items,
        { kind: "tab", id: tabItemId(EPIC_REF), ref: EPIC_REF },
      ],
      activeItemId: tabItemId(EPIC_REF),
      stripOrder: [...state.stripOrder, EPIC_REF],
    }));

    expect(open(null)).toBe(true);

    expect(navigateToTabIntent).toHaveBeenCalledWith({
      kind: "sample-workspace",
    });
    expect(sampleTabPresent()).toBe(true);
  });

  it("remembers what the sample tab interrupted, so closing it goes back", () => {
    open(null);

    const sample = useTabsStore
      .getState()
      .items.find(
        (item) => item.kind === "tab" && item.ref.kind === "sample-workspace",
      );
    expect(sample?.kind === "tab" ? sample.sampleReturnItemId : null).toBe(
      tabItemId(HISTORY_REF),
    );
  });

  it("never captures a return pointing at the sample tab itself", () => {
    // A capture of the sample tab is a tab that returns to itself, which
    // `removeLayoutRef` resolves to an item it has just removed.
    useTabsStore.setState({ activeItemId: tabItemId(SAMPLE_REF) });

    open(null);

    const sample = useTabsStore
      .getState()
      .items.find(
        (item) => item.kind === "tab" && item.ref.kind === "sample-workspace",
      );
    expect(sample?.kind).toBe("tab");
    expect(sample?.kind === "tab" ? sample.sampleReturnItemId : "unset").toBe(
      null,
    );
  });

  // Nothing here pins WHICH instance of a region the overlays follow, because
  // a live session has one to choose from: `PaneVisibilityContext` is
  // published by every top-level surface from its OWN visibility
  // (`epic-surface.tsx`, `hosted-chat-surface-context-bridge.tsx`), not from
  // split membership, so while the sample tab is the active item nothing else
  // registers at all - and the sample tab cannot be in a split, being
  // `splitEligibility: "ineligible"`. The gate itself is pinned where it
  // lives: `use-layout-region.test.tsx`'s "leaves a hidden pane's copy out of
  // the editor".

  it("preselects a deep-link target (5.3)", () => {
    open("minimap");

    expect(useLayoutEditorStore.getState().selected).toBe("minimap");
  });
});

describe("the system overlay the editor opens under (L-91)", () => {
  // The palette reaches the door from any surface, and `close()` is the one
  // dismissal both overlays share.
  it.each<SystemModalActive>([
    { kind: "settings", section: "layout" },
    { kind: "history", section: null },
  ])(
    "closes the $kind modal that would otherwise paint over the editor",
    (active) => {
      const overlay = publishModalApi(active);

      expect(open(null)).toBe(true);

      expect(overlay.close).toHaveBeenCalledOnce();
    },
  );

  it("never navigates back when no overlay is up", () => {
    // `close()` pops the router's history whenever the adjacent entry looks
    // like an overlay entry, so calling it unconditionally turns Customize
    // layout into a back gesture.
    const overlay = publishModalApi(null);

    open(null);

    expect(overlay.close).not.toHaveBeenCalled();
  });

  it("leaves the overlay alone when the width gate redirects into it", () => {
    // Below the gate the door sends the user INTO Settings > Layout; closing
    // the overlay would shut the surface the redirect is about to use.
    const overlay = publishModalApi({ kind: "settings", section: "layout" });
    setViewportWidth(700);

    expect(open(null)).toBe(false);

    expect(overlay.close).not.toHaveBeenCalled();
  });
});

describe("the command palette the door was reached from (L-134)", () => {
  /**
   * LV2-06. The palette dismisses itself AFTER the item it ran - a `finally`
   * in `runCommandItem`, a microtask later still because `run` is awaited -
   * and the sample tab's activation did not survive that: the editor docked
   * over the tab the user came from, with the sample workspace beside it as a
   * retained background tab registering nothing.
   *
   * The ordering is the whole fix, so the assertion is the ordering: what the
   * palette was doing at the moment the activation ran.
   */
  it("is already dismissed when the activation runs", () => {
    useCommandPaletteStore.setState({ open: true });
    let paletteWasOpen: boolean | null = null;
    navigateToTabIntent.mockImplementation(() => {
      paletteWasOpen = useCommandPaletteStore.getState().open;
    });

    expect(
      openLayoutEditor({
        source: "command_palette",
        entry: "keyboard",
        target: null,
        origin: { kind: "tab" },
        navigateToTabIntent,
      }),
    ).toBe(true);

    expect(navigateToTabIntent).toHaveBeenCalledOnce();
    expect(paletteWasOpen).toBe(false);
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it("leaves the width-gate redirect without a session to dismiss for", () => {
    // Below the gate there is no canvas to open, so the door redirects into
    // Settings > Layout - and the palette's own dismissal is the palette's
    // business on that path, not a layer the door has to put down first.
    useCommandPaletteStore.setState({ open: true });
    setViewportWidth(700);

    expect(open(null)).toBe(false);

    expect(useCommandPaletteStore.getState().open).toBe(true);
  });
});

describe("asked again from inside a live session (L-19, L-129)", () => {
  it("lands on the region the second request names", () => {
    // Since quick verbs work inside a session, the menu's own "Customize
    // layout..." is an ordinary gesture there. There is no second door to
    // open, so what is left of the request is the region it named.
    open(null);
    const session = useLayoutEditorStore.getState().session;
    expect(session).not.toBeNull();

    expect(
      openLayoutEditor({
        source: "direct_ui",
        entry: "pointer",
        target: "minimap",
        origin: { kind: "tab" },
        navigateToTabIntent,
      }),
    ).toBe(true);

    expect(useLayoutEditorStore.getState().session).toBe(session);
    expect(useLayoutEditorStore.getState().selected).toBe("minimap");
  });
});

describe("the single-window lease (L-32, 5.3)", () => {
  it("refuses to open while another window holds it", () => {
    window.localStorage.setItem(
      LAYOUT_EDITOR_LEASE_KEY,
      JSON.stringify({ token: "another-window", expiresAt: Date.now() + 5000 }),
    );

    expect(open(null)).toBe(false);
    expect(useLayoutEditorStore.getState().session).toBeNull();
    expect(useLayoutEditorStore.getState().lockedBy).toBe("other-window");
  });

  it("says why it refused, in the words every other door uses (T6)", () => {
    window.localStorage.setItem(
      LAYOUT_EDITOR_LEASE_KEY,
      JSON.stringify({ token: "another-window", expiresAt: Date.now() + 5000 }),
    );

    expect(open(null)).toBe(false);

    expect(toasts.info).toHaveBeenCalledExactlyOnceWith(
      "Open in another window. Your layout is saved there.",
    );
  });

  it("releases the lease on the way out", () => {
    open(null);
    expect(window.localStorage.getItem(LAYOUT_EDITOR_LEASE_KEY)).not.toBeNull();

    closeLayoutEditor("done");

    // Still held while the editor is still on screen and still writing: the
    // key goes back with the teardown, not 220ms before it (G2-03).
    expect(window.localStorage.getItem(LAYOUT_EDITOR_LEASE_KEY)).not.toBeNull();

    drainTransitions();

    expect(window.localStorage.getItem(LAYOUT_EDITOR_LEASE_KEY)).toBeNull();
  });

  it("keeps the lease alive past its TTL, and exits when another window takes it", () => {
    vi.useFakeTimers();
    try {
      open(null);

      // Well past the 6s TTL: only the heartbeat keeps the key this window's.
      vi.advanceTimersByTime(10_000);
      expect(readLayoutEditorLease()?.expiresAt).toBeGreaterThan(Date.now());

      // A window that took the key while this one was suspended past its TTL.
      const theirs = JSON.stringify({
        token: "another-window",
        expiresAt: Date.now() + 6000,
      });
      window.localStorage.setItem(LAYOUT_EDITOR_LEASE_KEY, theirs);
      vi.advanceTimersByTime(2_000);
      drainTransitions();

      expect(useLayoutEditorStore.getState().session).toBeNull();
      expect(toasts.info).toHaveBeenCalledWith(
        "Customize layout moved to another window. Your layout is saved.",
      );
      expect(window.localStorage.getItem(LAYOUT_EDITOR_LEASE_KEY)).toBe(theirs);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("leaving (5.3)", () => {
  it("puts the entry snapshot back on Discard and keeps it on Done", () => {
    open(null);
    useLayoutEditorStore.getState().recordGesture(() => {
      useLayoutStore.getState().setRegionValues("mic", { shown: "hidden" });
    });
    expect(getLayoutSnapshot().overrides.mic).toEqual({ shown: "hidden" });

    close("discard");

    expect(getLayoutSnapshot().overrides.mic).toBeUndefined();

    open(null);
    useLayoutEditorStore.getState().recordGesture(() => {
      useLayoutStore.getState().setRegionValues("mic", { shown: "hidden" });
    });
    close("done");

    expect(getLayoutSnapshot().overrides.mic).toEqual({ shown: "hidden" });
  });

  // The sample tab never outlives its session, whatever ended it: a sample
  // left behind after a tab switch or a lost lease was a Customizing tab
  // showing the sample with no inspector and no frame. Only `sample-closed`
  // is exempt - there is nothing left to close.
  const exits: Record<
    Exclude<LayoutEditorExitReason, "sample-closed">,
    () => void
  > = {
    done: () => close("done"),
    discard: () => close("discard"),
    "open-settings": () => close("open-settings"),
    "tab-switch": () => close("tab-switch"),
    "below-threshold": () => close("below-threshold"),
    "lease-lost": () => close("lease-lost"),
    abandoned: abandonLayoutEditorSession,
  };

  it.each(Object.entries(exits).map(([reason, exit]) => ({ reason, exit })))(
    "closes the sample tab it opened on $reason",
    ({ exit }) => {
      open(null);
      expect(sampleTabPresent()).toBe(true);

      exit();

      expect(sampleTabPresent()).toBe(false);
    },
  );

  it("is a no-op with no session open", () => {
    closeLayoutEditor("done");

    expect(useLayoutEditorStore.getState().session).toBeNull();
    expect(useLayoutEditorStore.getState().leaving).toBe(false);
    expect(transitions).toHaveLength(0);
    expect(toasts.info).not.toHaveBeenCalled();
  });
});

describe("the Cmd+W close-tab chord (item 3)", () => {
  it("returns false and does nothing with no session open", () => {
    expect(closeLayoutEditorForCloseTabChord()).toBe(false);
    expect(useLayoutEditorStore.getState().session).toBeNull();
  });

  it("runs Done and returns true with a session open", () => {
    open(null);
    expect(sampleTabPresent()).toBe(true);

    expect(closeLayoutEditorForCloseTabChord()).toBe(true);
    drainTransitions();

    expect(useLayoutEditorStore.getState().session).toBeNull();
    expect(sampleTabPresent()).toBe(false);
  });

  it("still returns true while an exit is already under way", () => {
    open(null);
    closeLayoutEditor("done");
    expect(useLayoutEditorStore.getState().leaving).toBe(true);

    expect(closeLayoutEditorForCloseTabChord()).toBe(true);

    drainTransitions();
    expect(useLayoutEditorStore.getState().session).toBeNull();
  });
});

describe("returning to the door's origin on exit (5.3)", () => {
  // A `null` area is Presets.
  it.each<{
    readonly reason: "done" | "discard";
    readonly area: SurfaceGroupId | null;
  }>([
    { reason: "done", area: "chat" },
    { reason: "discard", area: "sidebar" },
    { reason: "done", area: null },
  ])(
    "returns a settings-origin session to its area ($area) on $reason",
    ({ reason, area }) => {
      openWithOrigin({ kind: "settings", area }, null);

      close(reason);

      expect(navigation.navigateToLayoutArea).toHaveBeenCalledExactlyOnceWith(
        area,
      );
    },
  );

  it("never navigates to Settings for a tab-origin session", () => {
    // `open()` opens with a tab origin (L-87): closing the sample tab already
    // returns the user to the tab they came from, so there is no Settings
    // area to land on.
    open(null);

    close("done");

    expect(navigation.navigateToLayoutArea).not.toHaveBeenCalled();
  });

  it("returns to Settings when the sample tab is closed by hand, for a settings-origin session", () => {
    openWithOrigin({ kind: "settings", area: "topBar" }, null);

    useTabsStore.setState((state) => ({
      items: state.items.filter(
        (item) => item.kind !== "tab" || item.ref.kind !== "sample-workspace",
      ),
    }));
    drainTransitions();

    expect(useLayoutEditorStore.getState().session).toBeNull();
    expect(navigation.navigateToLayoutArea).toHaveBeenCalledExactlyOnceWith(
      "topBar",
    );
  });

  it("sends open-settings to the editor's own current area, not the origin's", () => {
    openWithOrigin({ kind: "settings", area: "chat" }, null);
    useLayoutEditorStore.getState().openArea("sidebar", null);

    close("open-settings");

    expect(navigation.navigateToLayoutArea).toHaveBeenCalledExactlyOnceWith(
      "sidebar",
    );
  });
});

describe("the entry method (L-30, L-54)", () => {
  it("records the gesture that reached the door on the session", () => {
    open(null);
    expect(useLayoutEditorStore.getState().session?.entry).toBe("pointer");

    close("done");
    // Keyboard entry is one of L-30's guards, so this one lands in the frame
    // it is made in whether or not the API is there.
    openLayoutEditor({
      source: "command_palette",
      entry: "keyboard",
      target: null,
      origin: { kind: "tab" },
      navigateToTabIntent,
    });

    expect(useLayoutEditorStore.getState().session?.entry).toBe("keyboard");
  });
});

describe("the guarded fallback exit (5.2)", () => {
  // The inspector's own slide-out exists only on the fallback branch, so these
  // three turn the app's Panel animations switch off rather than pretending
  // the browser has no View Transition API.
  beforeEach(forceReducedMotion);

  it("keeps the session open until the inspector has slid out", async () => {
    open("minimap");
    const slideOut = mountAnimatedInspector();

    closeLayoutEditor("done");

    // Still rendering the section the user was in: an inspector torn down
    // first would slide out as the empty index, which is the flash ticket 07
    // deferred rather than shipped.
    const state = useLayoutEditorStore.getState();
    expect(state.session).not.toBeNull();
    expect(state.selected).toBe("minimap");
    expect(state.leaving).toBe(true);

    slideOut.finishSlideOut();
    await tick();

    expect(useLayoutEditorStore.getState().session).toBeNull();
    expect(useLayoutEditorStore.getState().selected).toBeNull();
  });

  it("lets the first reason stand when a second arrives mid-exit", async () => {
    open(null);
    useLayoutEditorStore.getState().recordGesture(() => {
      useLayoutStore.getState().setRegionValues("mic", { shown: "hidden" });
    });
    const slideOut = mountAnimatedInspector();

    closeLayoutEditor("done");
    closeLayoutEditor("discard");
    slideOut.finishSlideOut();
    await tick();

    expect(useLayoutEditorStore.getState().session).toBeNull();
    // `done` keeps what the session wrote; the `discard` that arrived while it
    // was leaving did not quietly revert the user's changes.
    expect(getLayoutSnapshot().overrides.mic).toEqual({ shown: "hidden" });
  });

  it("hands the editor over to a session opened while it was still sliding out", async () => {
    open(null);
    const slideOut = mountAnimatedInspector();
    closeLayoutEditor("done");

    expect(open("minimap")).toBe(true);
    const reopened = useLayoutEditorStore.getState().session;
    slideOut.finishSlideOut();
    await tick();

    // The old session was torn down by the re-open itself, so the slide-out
    // landing afterwards has nothing left to do.
    expect(useLayoutEditorStore.getState().session).toBe(reopened);
    expect(useLayoutEditorStore.getState().selected).toBe("minimap");
  });
});

describe("re-opening during a view-transition exit (5.2, G2-02)", () => {
  it("tears the old session down before the new one is decided", () => {
    // The sample workspace is the thing the old teardown would take away: it
    // closes the tab by ref, and the re-open has just activated a tab under
    // that same ref.
    open(null);
    const first = useLayoutEditorStore.getState().session;
    expect(first).not.toBeNull();
    expect(sampleTabPresent()).toBe(true);

    // Done, then "actually, not yet" inside the exit's own 220ms. Neither
    // callback has run: on this branch both applies are deferred.
    closeLayoutEditor("done");
    expect(
      openLayoutEditor({
        source: "direct_ui",
        entry: "pointer",
        target: null,
        origin: { kind: "tab" },
        navigateToTabIntent,
      }),
    ).toBe(true);

    // The browser skips the first transition, so the exit's update callback
    // runs BEFORE the entry's. An exit teardown still in flight here would
    // close the tab the re-open just activated and leave the new session with
    // no sample tab under it.
    drainTransitions();

    const second = useLayoutEditorStore.getState().session;
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(sampleTabPresent()).toBe(true);
    // And the new session holds the key the old one gave back.
    expect(window.localStorage.getItem(LAYOUT_EDITOR_LEASE_KEY)).not.toBeNull();
  });
});

describe("the canvas or the shell going away before the entry transition lands", () => {
  function openWithoutDraining(): void {
    expect(
      openLayoutEditor({
        source: "direct_ui",
        entry: "pointer",
        target: null,
        origin: { kind: "tab" },
        navigateToTabIntent,
      }),
    ).toBe(true);
    expect(transitions.length).toBeGreaterThan(0);
  }

  it("begins no session when the sample tab was closed before the entry callback ran", () => {
    openWithoutDraining();

    useTabsStore.setState((state) => ({
      items: state.items.filter(
        (item) => item.kind !== "tab" || item.ref.kind !== "sample-workspace",
      ),
    }));
    drainTransitions();

    expect(useLayoutEditorStore.getState().session).toBeNull();
    expect(window.localStorage.getItem(LAYOUT_EDITOR_LEASE_KEY)).toBeNull();
    // The key is free again: a fresh open is not refused by a leaked lease.
    expect(open(null)).toBe(true);
  });

  it("begins no session and runs no heartbeat when the shell abandoned the editor before the entry callback ran", () => {
    vi.useFakeTimers();
    try {
      openWithoutDraining();

      abandonLayoutEditorSession();
      drainTransitions();

      expect(useLayoutEditorStore.getState().session).toBeNull();
      expect(window.localStorage.getItem(LAYOUT_EDITOR_LEASE_KEY)).toBeNull();

      // A heartbeat left running would re-take the lease on its next beat.
      vi.advanceTimersByTime(10_000);
      expect(window.localStorage.getItem(LAYOUT_EDITOR_LEASE_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("layout_editor_session analytics (L-46, L-54)", () => {
  it("fires once at exit with the session's own source and entry", () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    open(null);
    expect(trackSpy).not.toHaveBeenCalled();

    close("done");

    expect(trackSpy).toHaveBeenCalledExactlyOnceWith(
      AnalyticsEvent.LayoutEditorSession,
      expect.objectContaining({
        source: "direct_ui",
        entry: "pointer",
        discarded: false,
      }),
    );
  });

  it("carries no scene property, because there is only one scene (L-87)", () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    open(null);

    close("done");

    expect(trackSpy.mock.calls[0]?.[1]).not.toHaveProperty("scene");
  });

  it("reports first_change_bucket as null for a session with no change", () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    open(null);

    close("done");

    expect(trackSpy).toHaveBeenCalledExactlyOnceWith(
      AnalyticsEvent.LayoutEditorSession,
      expect.objectContaining({
        first_change_bucket: null,
        changed_count: 0,
        undo_count: 0,
        regions_touched_count: 0,
      }),
    );
    // The real `track` ran: the sanitizer admitted the null bucket.
    expect(trackSpy.mock.results[0]?.value).toBe(true);
  });

  it("counts an undo that landed", () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    open(null);
    useLayoutEditorStore.getState().recordGesture(() => {
      useLayoutStore.getState().setRegionValues("mic", { shown: "hidden" });
    });
    useLayoutEditorStore.getState().undo();

    close("done");

    expect(trackSpy).toHaveBeenCalledExactlyOnceWith(
      AnalyticsEvent.LayoutEditorSession,
      expect.objectContaining({ undo_count: 1, changed_count: 0 }),
    );
  });

  it("reports the entry method passed to the door", () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");

    openLayoutEditor({
      source: "command_palette",
      entry: "keyboard",
      target: null,
      origin: { kind: "tab" },
      navigateToTabIntent,
    });
    drainTransitions();
    close("done");

    expect(trackSpy).toHaveBeenCalledExactlyOnceWith(
      AnalyticsEvent.LayoutEditorSession,
      expect.objectContaining({ source: "command_palette", entry: "keyboard" }),
    );
  });

  // The Discard row is the ordering one: counts what was built before it, not
  // the zero left after it.
  it.each<{
    readonly reason: "done" | "discard";
    readonly discarded: boolean;
    readonly micAfter: { readonly shown: "hidden" } | undefined;
  }>([
    { reason: "done", discarded: false, micAfter: { shown: "hidden" } },
    { reason: "discard", discarded: true, micAfter: undefined },
  ])(
    "counts the value change made this session and the region it touched on $reason",
    ({ reason, discarded, micAfter }) => {
      const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
      open(null);
      useLayoutEditorStore.getState().recordGesture(() => {
        useLayoutStore.getState().setRegionValues("mic", { shown: "hidden" });
      });

      close(reason);

      expect(trackSpy).toHaveBeenCalledExactlyOnceWith(
        AnalyticsEvent.LayoutEditorSession,
        expect.objectContaining({
          discarded,
          changed_count: 1,
          regions_touched_count: 1,
        }),
      );
      expect(getLayoutSnapshot().overrides.mic).toEqual(micAfter);
    },
  );
});

describe("the canvas going away underneath the editor (5.3)", () => {
  it("exits when another tab takes over, closing the sample tab behind it and leaving the switched-to tab active", () => {
    open(null);

    useTabsStore.setState((state) => ({
      items: [
        ...state.items,
        { kind: "tab", id: tabItemId(EPIC_REF), ref: EPIC_REF },
      ],
      activeItemId: tabItemId(EPIC_REF),
      stripOrder: [...state.stripOrder, EPIC_REF],
    }));
    drainTransitions();

    expect(useLayoutEditorStore.getState().session).toBeNull();
    expect(sampleTabPresent()).toBe(false);
    expect(useTabsStore.getState().activeItemId).toBe(tabItemId(EPIC_REF));
  });
});
