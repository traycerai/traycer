import "../../../../../__tests__/test-browser-apis";

import type { HistoryItem } from "@/components/home/data/home-page.data";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Fixed "now" so the bucketed timestamp labels are deterministic. The rows read
// `updatedAtMs`, so each fixture is expressed as an offset from this.
const NOW_MS = Date.UTC(2026, 6, 30, 12, 0, 0);

const testState: {
  items: ReadonlyArray<HistoryItem>;
  signOut: () => Promise<void>;
  openExternalLink: (url: string) => Promise<void>;
  openSettings: () => void;
} = {
  items: [],
  signOut: () => Promise.resolve(),
  openExternalLink: () => Promise.resolve(),
  openSettings: () => undefined,
};

vi.mock("@/hooks/home/use-history-query", () => ({
  useHistoryQuery: () => ({
    data: { items: testState.items, totalCount: testState.items.length },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
    fetchNextPage: () => undefined,
    hasNextPage: false,
    isFetchingNextPage: false,
  }),
}));

vi.mock("@/lib/analytics", () => ({
  AnalyticsEvent: {
    SettingsOpened: "SettingsOpened",
    SubscriptionManagementOpened: "SubscriptionManagementOpened",
    SignOutRequested: "SignOutRequested",
  },
  Analytics: { getInstance: () => ({ track: () => undefined }) },
}));

vi.mock("@/lib/host", () => ({
  useAuthService: () => ({ signOut: () => testState.signOut() }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    authnBaseUrl: "https://authn.test",
    // The platform origin comes from `signInUrl`, which every shell already
    // composes from its configured cloud-UI base.
    signInUrl: "https://platform.test/sign-in",
    openExternalLink: (url: string) => testState.openExternalLink(url),
  }),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: () => testState.openSettings(),
    openHistory: () => undefined,
  }),
}));

vi.mock("@/lib/commands/actions/new-epic", () => ({
  openNewEpicDraft: () => ({ kind: "draft" }),
}));

vi.mock("@/lib/tab-navigation", () => ({
  draftTabIntent: (value: unknown) => value,
  navigateToTabIntent: () => undefined,
}));

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { domMax, LazyMotion } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestRouterProvider } from "../../../../__tests__/with-test-router";
import { MobileNavDrawer } from "@/components/layout/shell/mobile-nav-drawer";
import { setMobileApp } from "@/lib/mobile-app";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";

function historyItem(overrides: {
  readonly id: string;
  readonly title: string;
  readonly updatedAtMs: number;
}): HistoryItem {
  return {
    id: overrides.id,
    epicId: overrides.id,
    taskType: "epic",
    title: overrides.title,
    initialUserPrompt: "",
    updatedAtMs: overrides.updatedAtMs,
    updatedLabel: "about 1 month ago",
    updatedBucket: "earlier",
    linkedRepos: [],
    linkedWorkspaces: [],
    chatHostIds: null,
    worktreeBranches: [],
    worktreePaths: [],
    pullRequestNumbers: [],
    ownership: "mine",
    permissionRole: null,
    isPinned: false,
  };
}

/**
 * Returns the Testing Library container, which is a direct child of the
 * document body and therefore stands in for "the rest of the app" when the
 * modal containment tests below check what got sealed off.
 *
 * `LazyMotion` is what the installed-app branch's panel needs to exist at all:
 * it is a lazily-featured motion element, and without the feature bundle in
 * context it renders with no drag and no transform.
 */
function renderDrawer(): HTMLElement {
  const { container } = render(
    <LazyMotion features={domMax}>
      <TestRouterProvider>
        <MobileNavDrawer />
      </TestRouterProvider>
    </LazyMotion>,
  );
  return container;
}

describe("MobileNavDrawer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW_MS);
    testState.items = [];
    testState.signOut = () => Promise.resolve();
    testState.openExternalLink = () => Promise.resolve();
    testState.openSettings = () => undefined;
    useMobileNavStore.setState({ open: true });
    useAuthStore.setState({
      profile: {
        userId: "u1",
        userName: "devansh",
        email: "devansh@traycer.ai",
        avatarUrl: null,
      },
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useMobileNavStore.setState({ open: false });
    useAuthStore.setState({ profile: null });
    setMobileApp(false);
  });

  describe("platform branch", () => {
    // Distinguished by markers neither branch sets by hand: the Sheet path
    // carries the shadcn primitive's own `data-slot`, and the installed-app
    // path carries none because nothing wraps its panel. Proof the branch
    // really swapped surfaces rather than only a class name.
    it("renders the motion-owned surface when installed as the mobile app", async () => {
      setMobileApp(true);
      renderDrawer();

      const drawer = await screen.findByTestId("mobile-nav-drawer");

      expect(drawer.getAttribute("role")).toBe("dialog");
      expect(drawer.hasAttribute("data-slot")).toBe(false);
      expect(drawer.hasAttribute("data-vaul-drawer")).toBe(false);
      // The layer sits directly under the body rather than inside the app
      // tree, which is the arrangement that lets the containment inert
      // everything beside it without inerting the drawer too.
      expect(screen.getByTestId("mobile-nav-drawer-layer").parentElement).toBe(
        document.body,
      );
    });

    it("renders the radix Sheet primitive outside the installed app", async () => {
      setMobileApp(false);
      renderDrawer();

      const drawer = await screen.findByTestId("mobile-nav-drawer");

      expect(drawer.getAttribute("data-slot")).toBe("sheet-content");
      expect(screen.queryByTestId("mobile-nav-drawer-layer")).toBeNull();
    });

    // The panel outlives the open state because the drag engine can only start
    // a gesture against a component that has already subscribed - so a closed
    // drawer is a mounted one, parked off screen. `inert` is what keeps that
    // from becoming a menu a keyboard user can tab into while it is invisible.
    it("keeps the panel mounted but sealed off while the drawer is closed", async () => {
      setMobileApp(true);
      useMobileNavStore.setState({ open: false });
      renderDrawer();

      const drawer = await screen.findByTestId("mobile-nav-drawer");

      expect(drawer.hasAttribute("inert")).toBe(true);
      expect(drawer.getAttribute("aria-hidden")).toBe("true");
      expect(drawer.getAttribute("aria-modal")).toBe("false");
    });

    // Visual state and semantic state are decoupled: the transform is
    // continuous and the modality is a boolean that flips only at a settled
    // endpoint. This pins the semantic half - a half-dragged panel may still
    // spring back, and assistive technology has no mid-drag state to be told
    // about.
    it("takes on modal semantics only while the drawer is open", async () => {
      setMobileApp(true);
      renderDrawer();

      const drawer = await screen.findByTestId("mobile-nav-drawer");

      expect(drawer.hasAttribute("inert")).toBe(false);
      expect(drawer.getAttribute("aria-hidden")).toBe("false");
      expect(drawer.getAttribute("aria-modal")).toBe("true");
    });

    // The rest of the document goes inert for as long as the drawer is modal,
    // which is one attribute standing in for a focus trap, a scroll lock and an
    // aria-hidden sweep. Prior state is restored on the way out rather than
    // blanket-cleared.
    it("seals the rest of the document off while open, and gives it back", async () => {
      setMobileApp(true);
      const container = renderDrawer();
      await screen.findByTestId("mobile-nav-drawer");

      expect(container.inert).toBe(true);

      act(() => {
        useMobileNavStore.setState({ open: false });
      });
      await waitFor(() => {
        expect(container.inert).toBe(false);
      });
    });

    // Focus entry is explicit here rather than a primitive's default: the
    // panel is focused at the settled-open endpoint, so a keyboard or
    // switch-control user lands inside the menu instead of being stranded on
    // an obscured trigger behind it.
    it("moves focus into the drawer content when opened as the installed app", async () => {
      setMobileApp(true);
      renderDrawer();

      const drawer = await screen.findByTestId("mobile-nav-drawer");

      await waitFor(() => {
        expect(drawer.contains(document.activeElement)).toBe(true);
      });
    });

    it("dismisses on Escape while open", async () => {
      setMobileApp(true);
      renderDrawer();
      await screen.findByTestId("mobile-nav-drawer");

      fireEvent.keyDown(document, { key: "Escape" });

      expect(useMobileNavStore.getState().open).toBe(false);
    });
  });

  /**
   * The settle is what separates "asked for" from "true", so these need a panel
   * with somewhere to travel. jsdom lays nothing out and reports `offsetWidth`
   * 0, which collapses both endpoints onto the same coordinate and makes every
   * request reconcile instantly - the one case that cannot show the gap. A
   * stubbed width gives the panel 300px to cross.
   */
  describe("settled state versus requested state", () => {
    // jsdom defines `offsetWidth` on the prototype itself, so the stub has to
    // put the real descriptor back rather than delete it - dropping it would
    // leave every later test in this file reading `undefined` for a width.
    const nativeOffsetWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetWidth",
    );

    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
        value: 300,
        configurable: true,
      });
      setMobileApp(true);
      useMobileNavStore.setState({ open: false });
    });
    afterEach(() => {
      if (nativeOffsetWidth === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
        return;
      }
      Object.defineProperty(
        HTMLElement.prototype,
        "offsetWidth",
        nativeOffsetWidth,
      );
    });

    // The bug this pins: keying modality off the request means a hamburger tap
    // announces a dialog and traps focus into a panel that is still off screen,
    // and a close hands the app back while the drawer is still covering it.
    it("does not take on modal semantics the moment the drawer is requested", async () => {
      const container = renderDrawer();
      const drawer = await screen.findByTestId("mobile-nav-drawer");

      act(() => {
        useMobileNavStore.setState({ open: true });
      });

      expect(drawer.getAttribute("aria-modal")).toBe("false");
      expect(drawer.getAttribute("aria-hidden")).toBe("true");
      expect(container.inert).toBeFalsy();
    });

    // An interrupted settle decides nothing. Whatever overtook it - here a
    // second request - owns the outcome, so the semantics must still be sitting
    // where they started rather than half-way through a flip.
    it("flips nothing when a settle is overtaken before it arrives", async () => {
      const container = renderDrawer();
      const drawer = await screen.findByTestId("mobile-nav-drawer");

      act(() => {
        useMobileNavStore.setState({ open: true });
      });
      act(() => {
        useMobileNavStore.setState({ open: false });
      });

      expect(drawer.getAttribute("aria-modal")).toBe("false");
      expect(drawer.getAttribute("aria-hidden")).toBe("true");
      expect(container.inert).toBeFalsy();
    });

    // Deferring the flip must not be the same thing as dropping it, so this
    // pins that the request left a settle RUNNING rather than going nowhere.
    // `inert` is the tell: a closed panel is inert only once it is also at
    // rest, so an open request that armed nothing would show up here as an
    // inert panel rather than a travelling one.
    //
    // Arrival itself is asserted where it can be observed without an animation
    // clock - the sibling describe, whose panel has no width to cross, so both
    // endpoints are the same coordinate and the same reconcile path runs
    // synchronously. Waiting on a real spring here would bind the test to
    // whether the frame loop advances under faked timers, which says nothing
    // about the drawer.
    it("arms a settle rather than dropping the request", async () => {
      renderDrawer();
      const drawer = await screen.findByTestId("mobile-nav-drawer");

      expect(drawer.hasAttribute("inert")).toBe(true);

      act(() => {
        useMobileNavStore.setState({ open: true });
      });

      expect(drawer.hasAttribute("inert")).toBe(false);
      expect(drawer.getAttribute("aria-modal")).toBe("false");
    });
  });

  /**
   * The entries into the drag that this file can reach without a real
   * compositor: the document-level close recognizer, whose listeners are plain
   * DOM ones, and the scrim, whose pointer handling replaced a click handler.
   * jsdom lays nothing out, so what is asserted here is the handoff and its
   * side effects - the tracking itself only exists on a device.
   */
  describe("gesture entry points", () => {
    beforeEach(() => {
      setMobileApp(true);
    });

    /**
     * Builds the events the recognizer reads. jsdom ships no usable
     * `PointerEvent` constructor, so this is a plain `Event` wearing the fields
     * the listeners actually touch, matching the approach in the shell-gesture
     * suite.
     */
    function dispatchPointer(
      type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
      options: {
        readonly clientX: number;
        readonly clientY: number;
        readonly target: EventTarget;
        readonly timeStamp: number;
        // Explicit rather than assumed: the helper under test binds itself to
        // the pointer that armed it, so a test that could not name a second
        // finger could not reach that boundary at all.
        readonly pointerId: number;
        readonly isPrimary: boolean;
      },
    ): void {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clientX", {
        value: options.clientX,
        configurable: true,
      });
      Object.defineProperty(event, "clientY", {
        value: options.clientY,
        configurable: true,
      });
      Object.defineProperty(event, "pointerId", {
        value: options.pointerId,
        configurable: true,
      });
      Object.defineProperty(event, "isPrimary", {
        value: options.isPrimary,
        configurable: true,
      });
      Object.defineProperty(event, "timeStamp", {
        value: options.timeStamp,
        configurable: true,
      });
      act(() => {
        options.target.dispatchEvent(event);
      });
    }

    // The hamburger is the only way in. A rightward drag from the screen's
    // leading edge belongs to whatever surface is underneath it - a chat
    // timeline, the canvas, a terminal - and the drawer must take no part of
    // it: the panel stays parked, the store stays shut, and a focused field
    // keeps its caret rather than being blurred by a gesture that opened
    // nothing.
    it("leaves the drawer shut on a rightward drag from the screen edge", async () => {
      useMobileNavStore.setState({ open: false });
      renderDrawer();
      await screen.findByTestId("mobile-nav-drawer");
      const input = document.createElement("input");
      document.body.appendChild(input);
      input.focus();

      dispatchPointer("pointerdown", {
        clientX: 20,
        clientY: 100,
        target: document.body,
        timeStamp: 0,
        pointerId: 1,
        isPrimary: true,
      });
      dispatchPointer("pointermove", {
        clientX: 90,
        clientY: 100,
        target: document.body,
        timeStamp: 100,
        pointerId: 1,
        isPrimary: true,
      });
      dispatchPointer("pointerup", {
        clientX: 200,
        clientY: 100,
        target: document.body,
        timeStamp: 200,
        pointerId: 1,
        isPrimary: true,
      });

      expect(useMobileNavStore.getState().open).toBe(false);
      expect(document.activeElement).toBe(input);
      expect(
        screen.getByTestId("mobile-nav-drawer").hasAttribute("inert"),
      ).toBe(true);
    });

    /**
     * The release cannot ask the drag engine whether the pointer moved. Moves
     * are batched to the next frame and the pending one is cancelled the
     * instant the pointer lifts, so a gesture that begins and ends inside a
     * single frame reports nothing at all - indistinguishable, from the
     * engine's side, from a press that never travelled. These two pin the
     * coordinates being tracked independently, which is the only thing that
     * tells the cases apart.
     */
    it("does not close on a press that travelled but outran the drag engine", async () => {
      renderDrawer();
      const scrim = await screen.findByTestId("mobile-nav-drawer-scrim");

      dispatchPointer("pointerdown", {
        clientX: 300,
        clientY: 400,
        target: scrim,
        timeStamp: 0,
        pointerId: 1,
        isPrimary: true,
      });
      // Rightward, into the drawer: this gesture asked for it to STAY open.
      dispatchPointer("pointermove", {
        clientX: 360,
        clientY: 400,
        target: window,
        timeStamp: 4,
        pointerId: 1,
        isPrimary: true,
      });
      dispatchPointer("pointerup", {
        clientX: 360,
        clientY: 400,
        target: window,
        timeStamp: 8,
        pointerId: 1,
        isPrimary: true,
      });

      expect(useMobileNavStore.getState().open).toBe(true);
    });

    // A cancelled pointer is never a tap however little it travelled - the
    // system took the gesture away, which is not a decision the user made.
    it("does not close when the system cancels a scrim press", async () => {
      renderDrawer();
      const scrim = await screen.findByTestId("mobile-nav-drawer-scrim");

      dispatchPointer("pointerdown", {
        clientX: 300,
        clientY: 400,
        target: scrim,
        timeStamp: 0,
        pointerId: 1,
        isPrimary: true,
      });
      dispatchPointer("pointercancel", {
        clientX: 300,
        clientY: 400,
        target: window,
        timeStamp: 8,
        pointerId: 1,
        isPrimary: true,
      });

      expect(useMobileNavStore.getState().open).toBe(true);
    });

    // The helper is bound to the pointer that armed it. A second finger is
    // somebody else's gesture: its release says nothing about this one, and the
    // hand that started the drag is still on the glass when it lands.
    it("ignores a second finger lifting while the arming pointer is still down", async () => {
      renderDrawer();
      const scrim = await screen.findByTestId("mobile-nav-drawer-scrim");

      dispatchPointer("pointerdown", {
        clientX: 300,
        clientY: 400,
        target: scrim,
        timeStamp: 0,
        pointerId: 1,
        isPrimary: true,
      });
      dispatchPointer("pointerup", {
        clientX: 100,
        clientY: 100,
        target: window,
        timeStamp: 8,
        pointerId: 2,
        isPrimary: false,
      });

      expect(useMobileNavStore.getState().open).toBe(true);

      // And the arming pointer's own release still decides, so the binding
      // narrows the tracker rather than deafening it.
      dispatchPointer("pointerup", {
        clientX: 300,
        clientY: 400,
        target: window,
        timeStamp: 20,
        pointerId: 1,
        isPrimary: true,
      });

      expect(useMobileNavStore.getState().open).toBe(false);
    });

    // Tap and drag enter through the same pointerdown on the scrim, so only the
    // release can tell them apart: a pointer that never travelled is a tap to
    // close. Dismissal rides that release rather than a click, which would
    // otherwise fire a second time after every drag ending on the scrim.
    it("closes on a scrim press that never travels", async () => {
      renderDrawer();
      const scrim = await screen.findByTestId("mobile-nav-drawer-scrim");

      dispatchPointer("pointerdown", {
        clientX: 300,
        clientY: 400,
        target: scrim,
        timeStamp: 0,
        pointerId: 1,
        isPrimary: true,
      });
      dispatchPointer("pointerup", {
        clientX: 300,
        clientY: 400,
        target: window,
        timeStamp: 40,
        pointerId: 1,
        isPrimary: true,
      });

      expect(useMobileNavStore.getState().open).toBe(false);
    });
  });

  describe("identity row", () => {
    it("reaches both account actions in one tap", async () => {
      renderDrawer();

      expect(
        await screen.findByTestId("mobile-nav-manage-subscription"),
      ).not.toBeNull();
      expect(screen.queryByTestId("mobile-nav-sign-out")).not.toBeNull();
      // Settings stays pinned in the footer rather than joining the identity
      // row's icon pair.
      expect(screen.queryByTestId("mobile-nav-settings")).not.toBeNull();
    });

    // Both controls are icon-only, and Radix tooltips never open on touch - the
    // accessible name is the only label a phone user's screen reader gets.
    it("names both icon-only controls", async () => {
      renderDrawer();

      expect(
        (
          await screen.findByTestId("mobile-nav-manage-subscription")
        ).getAttribute("aria-label"),
      ).toBe("Manage subscription");
      expect(
        screen.getByTestId("mobile-nav-sign-out").getAttribute("aria-label"),
      ).toBe("Sign out");
    });

    it("opens the subscription page through the runner host", async () => {
      const opened: string[] = [];
      testState.openExternalLink = (url) => {
        opened.push(url);
        return Promise.resolve();
      };
      renderDrawer();
      fireEvent.click(
        await screen.findByTestId("mobile-nav-manage-subscription"),
      );

      expect(opened.length).toBe(1);
      // `resolvePlatformBaseUrl` takes the origin of the shell's own
      // `signInUrl`, so this tracks whatever deployment is configured rather
      // than rewriting a hostname label.
      expect(opened[0]).toBe("https://platform.test");
      expect(useMobileNavStore.getState().open).toBe(false);
    });

    it("confirms before signing out, then closes the drawer", async () => {
      let signedOut = 0;
      testState.signOut = () => {
        signedOut += 1;
        return Promise.resolve();
      };
      renderDrawer();
      fireEvent.click(await screen.findByTestId("mobile-nav-sign-out"));

      // The tap only asks. Unlike its neighbours this control leaves the
      // drawer open, so cancelling returns the user where they were.
      expect(signedOut).toBe(0);
      expect(useMobileNavStore.getState().open).toBe(true);

      fireEvent.click(await screen.findByTestId("confirm-action"));

      expect(signedOut).toBe(1);
      expect(useMobileNavStore.getState().open).toBe(false);
    });

    it("keeps the session and the drawer when the confirm is cancelled", async () => {
      let signedOut = 0;
      testState.signOut = () => {
        signedOut += 1;
        return Promise.resolve();
      };
      renderDrawer();
      fireEvent.click(await screen.findByTestId("mobile-nav-sign-out"));
      fireEvent.click(await screen.findByTestId("confirm-cancel"));

      await waitFor(() => {
        expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
      });
      expect(signedOut).toBe(0);
      expect(useMobileNavStore.getState().open).toBe(true);
    });

    // Notifications live in the header now (`MobileNotificationsButton`), so
    // an unresolved profile simply drops the whole account block, actions
    // included.
    it("drops the account block when no profile has resolved", async () => {
      useAuthStore.setState({ profile: null });
      renderDrawer();
      await screen.findByTestId("mobile-nav-new-task");

      expect(screen.queryByTestId("mobile-nav-manage-subscription")).toBeNull();
      expect(screen.queryByTestId("mobile-nav-sign-out")).toBeNull();
    });
  });

  describe("task rows", () => {
    it("labels rows with the compact bucketed timestamp, not the verbose one", async () => {
      testState.items = [
        historyItem({
          id: "a",
          title: "hello",
          updatedAtMs: NOW_MS - 2 * HOUR_MS,
        }),
        historyItem({
          id: "b",
          title: "neww",
          updatedAtMs: NOW_MS - 30 * DAY_MS,
        }),
      ];
      renderDrawer();
      const rows = await screen.findAllByTestId("mobile-nav-task-row");

      expect(rows.length).toBe(2);
      expect(rows[0]?.textContent).toContain("2h ago");
      // The shared verbose label stays on the item for the landing list / tray;
      // this surface must not render it.
      expect(rows[1]?.textContent).not.toContain("about 1 month ago");
    });

    it("renders no leading glyph on a task row", async () => {
      testState.items = [
        historyItem({ id: "a", title: "hello", updatedAtMs: NOW_MS - DAY_MS }),
      ];
      renderDrawer();
      const rows = await screen.findAllByTestId("mobile-nav-task-row");

      expect(rows[0]?.querySelector("svg")).toBeNull();
    });
  });
});
