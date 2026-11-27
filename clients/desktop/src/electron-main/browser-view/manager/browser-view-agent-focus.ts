import { randomUUID } from "node:crypto";
import type { Input, InputEvent, MouseInputEvent } from "electron";
import type {
  BrowserCdpCommand,
  BrowserCdpResult,
  BrowserCdpTarget,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserViewAgentFocusReport,
  BrowserViewAgentFocusSignal,
} from "@traycer-clients/shared/platform/browser-view";
import { RunnerHostEvent } from "../../../ipc-contracts/ipc-channels";
import { describeLogError, log } from "../../app/logger";
import type {
  BrowserDebugLease,
  BrowserDebugSession,
} from "../debug/browser-debug-session";
import type { BrowserViewDebugger } from "../browser-view-port";
import type { BrowserViewEntry, BrowserViewSend } from "./browser-view-entry";
import type { BrowserViewEntryRegistry } from "./browser-view-entry-registry";
import type { BrowserViewDebugSessions } from "./debug-session-for";

/** The curated commands that inject input, and so can move keyboard focus. */
export type BrowserCdpInputCommand = Extract<
  BrowserCdpCommand,
  {
    readonly kind:
      | "cdpDispatchMouseEvent"
      | "cdpDispatchKeyEvent"
      | "cdpInsertText";
  }
>;

export function isBrowserCdpInputCommand(
  command: BrowserCdpCommand,
): command is BrowserCdpInputCommand {
  return (
    command.kind === "cdpDispatchMouseEvent" ||
    command.kind === "cdpDispatchKeyEvent" ||
    command.kind === "cdpInsertText"
  );
}

export interface BrowserViewFocusHostWebContents {
  readonly debugger: BrowserViewDebugger;
  isDestroyed(): boolean;
  on: NodeJS.EventEmitter["on"];
  off: NodeJS.EventEmitter["off"];
}

/** A host window as the guard reads it; an Electron `BrowserWindow` is one. */
export interface BrowserViewFocusWindow {
  readonly webContents: BrowserViewFocusHostWebContents;
  isFocused(): boolean;
  isDestroyed(): boolean;
  on(event: "focus", listener: () => void): unknown;
  on(event: "blur", listener: () => void): unknown;
  on(event: "closed", listener: () => void): unknown;
  off(event: "focus", listener: () => void): unknown;
  off(event: "blur", listener: () => void): unknown;
  off(event: "closed", listener: () => void): unknown;
}

interface BrowserViewAgentFocusOptions {
  readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  readonly debugSessions: BrowserViewDebugSessions;
  readonly getWindow: (windowId: string) => BrowserViewFocusWindow | null;
  readonly send: BrowserViewSend;
}

/** Where the person's keyboard focus belongs in one window. */
type FocusOwner = BrowserViewEntry | "app";

interface WindowFocus {
  readonly windowId: string;
  readonly window: BrowserViewFocusWindow;
  readonly app: BrowserViewFocusHostWebContents;
  owner: FocusOwner;
  /** The tile the person last pressed into: focus there is theirs. */
  personTook: BrowserViewEntry | null;
  /**
   * An agent tab an input left holding focus that could not go back yet: the
   * window is behind, or the owner's page could not be reached. Set where the
   * input moved focus, so no other input reads that tab as the person's.
   */
  parkedIn: BrowserViewEntry | null;
  /**
   * The host page's debugger is attached only while this window has agent
   * input to guard: a held attachment would refuse the renderer heap
   * measurement, which will not share one. False while the guard uses an
   * attachment someone else made.
   */
  hostAttachedByGuard: boolean;
  /** Agent inputs from their preparation to their end; the guard stays attached while any is. */
  inputs: number;
  /**
   * Answered once the owner's page has applied the last hand-back. Chromium
   * sets page focus on a page's input channel, which is not ordered with the
   * one `end` takes, and answers an injected press only after the page
   * handled it: a bracket closes after this, so no page focus change, nor the
   * emulation that hid it ending, can reach the page after its `end`.
   */
  handedBack: Promise<void>;
  appEmulated: boolean;
  readonly pendingBegins: Map<string, PendingBegin>;
  readonly removeListeners: () => void;
}

/**
 * How a `begin` ended. `opened`: the page holds the bracket open. `unguarded`:
 * the page runs no guard, so nothing is waited for. `abandoned`: the page will
 * not open it (it is going, stalled, or the tab closed), and the input is not
 * sent, since nothing would hide or undo the focus it moves.
 */
type BeginOutcome = "opened" | "unguarded" | "abandoned";

interface PendingBegin {
  readonly entry: BrowserViewEntry;
  /** The page holds the bracket for a composition: no deadline while it does. */
  readonly hold: () => void;
  readonly finish: (outcome: BeginOutcome) => void;
}

interface TabFocus {
  /** Agent inputs between `begin` and `end` on this tab. */
  inFlight: number;
  pressesInFlight: number;
  /** Set only while an agent input is being dispatched, which is synchronous. */
  injecting: "press" | "input" | null;
  pressSeen: boolean;
  /**
   * Agent presses dispatched without reaching `before-mouse-event` yet. One
   * aimed at a cross-site frame is routed after the dispatch call returns and
   * before CDP answers it, which waits for the target page's ack: a press not
   * seen by then never arrives, so the last answered press clears them.
   */
  pressTokens: number;
  lastPressByAgent: boolean;
  /** The debugger attachment the tab's emulation and focused frame were set on. */
  preparedAttachment: number | null;
  /** Held while this tile, driven by no agent, is the owner a hand-back targets. */
  ownerLease: BrowserDebugLease | null;
  ownerEmulated: boolean;
}

/** Outside every viewport: only a page's own root widget can be hit there. */
const OFF_VIEW_POINT = { x: -1, y: -1 } as const;
/**
 * A page that runs the guard answers a `begin` at once, so this bounds only a
 * page whose main thread is stalled; its input is abandoned.
 */
const BEGIN_ACK_DEADLINE_MS = 10_000;
const FOCUS_WORLD_NAME = "traycer-agent-focus";

/**
 * Keeps an agent's input in a browser tile from taking the person's keyboard
 * focus anywhere in the window.
 *
 * Chromium moves a window's keyboard focus into the page a press lands in,
 * injected or not, and an injected event first focuses its page. Main hands
 * focus back to the person's owner (the app, or the tile they last pressed
 * into) in the same task the agent's input moved it, with a press that has no
 * button: Chromium moves focus for it and Blink drops it, so no page sees a
 * click. The window's page brackets each agent input (`begin`/`end`), holds
 * back the focus events in between and restores the element that had focus.
 * Focus emulation keeps the owner's page, and every agent tab, reading as
 * focused while page focus passes through them.
 *
 * A press is the person's when it is not one of these: the guard's own, an
 * agent press being dispatched (`injecting`), or one routed after its dispatch
 * returned while its command is in flight (`pressTokens`).
 */
export class BrowserViewAgentFocus {
  private readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  private readonly debugSessions: BrowserViewDebugSessions;
  private readonly getWindow: (
    windowId: string,
  ) => BrowserViewFocusWindow | null;
  private readonly send: BrowserViewSend;
  private readonly windows = new Map<string, WindowFocus>();
  private readonly tabs = new Map<BrowserViewEntry, TabFocus>();
  /** Windows whose current page said it runs the guard; only these are waited on. */
  private readonly guardedWindows = new Set<string>();
  /** True while one of the guard's own buttonless presses is dispatched. */
  private ownPress = false;

  constructor(options: BrowserViewAgentFocusOptions) {
    this.entries = options.entries;
    this.debugSessions = options.debugSessions;
    this.getWindow = options.getWindow;
    this.send = options.send;
  }

  /** Runs one agent input on `entry` and leaves the person's focus where it was. */
  async dispatchInput(
    entry: BrowserViewEntry,
    session: BrowserDebugSession,
    target: BrowserCdpTarget,
    command: BrowserCdpInputCommand,
  ): Promise<BrowserCdpResult> {
    const window = this.windowFocus(entry.identity.lifecycleWindowId);
    if (window === null || !this.ensureHost(window)) {
      return session.dispatch(target, command);
    }
    // Counted before the first wait: another tab's input ending while this one
    // is prepared would otherwise detach the hand-back's debugger under it.
    window.inputs += 1;
    try {
      await this.prepare(window, entry, session);
      return await this.bracketed(window, entry, session, target, command);
    } finally {
      window.inputs -= 1;
      this.releaseIfIdle(window);
    }
  }

  private async bracketed(
    window: WindowFocus,
    entry: BrowserViewEntry,
    session: BrowserDebugSession,
    target: BrowserCdpTarget,
    command: BrowserCdpInputCommand,
  ): Promise<BrowserCdpResult> {
    const tab = this.tabFor(entry);
    const bracketId = randomUUID();
    const outcome = await this.begin(window, entry, bracketId);
    if (outcome === "abandoned") {
      // Closes it in a page that still opens it late: a stalled one, or one
      // whose composition ends.
      this.signal(window, {
        kind: "end",
        bracketId,
        registrationId: entry.identity.registrationId,
      });
      return {
        kind: command.kind,
        ok: false,
        error: {
          kind: "cdp_error",
          message:
            "Input not sent: the app window was reloading or not responding, or the tab closed",
          code: null,
        },
      };
    }
    const kind =
      command.kind !== "cdpDispatchMouseEvent"
        ? "key"
        : command.type === "mousePressed"
          ? "press"
          : "pointer";
    tab.inFlight += 1;
    if (kind === "press") tab.pressesInFlight += 1;
    try {
      return await session.dispatchInput(target, command, (send) =>
        this.inject(window, entry, tab, kind, send),
      );
    } finally {
      tab.inFlight -= 1;
      if (kind === "press") {
        tab.pressesInFlight -= 1;
        if (tab.pressesInFlight === 0) tab.pressTokens = 0;
        if (this.isActive(window) && this.isStolen(window, entry)) {
          this.handBack(window);
        }
      }
      if (this.isStolen(window, entry)) window.parkedIn = entry;
      else if (window.parkedIn === entry) window.parkedIn = null;
      await window.handedBack;
      this.signal(window, {
        kind: "end",
        bracketId,
        registrationId: entry.identity.registrationId,
      });
    }
  }

  report(windowId: string, report: BrowserViewAgentFocusReport): void {
    const window = this.windows.get(windowId);
    switch (report.kind) {
      case "guardStarted":
        this.guardedWindows.add(windowId);
        return;
      case "guardStopped":
        if (window === undefined) this.guardedWindows.delete(windowId);
        else this.resetPage(window);
        return;
      // An answer for a bracket no longer pending, from a page since replaced
      // included, changes nothing.
      case "bracketHeld":
        window?.pendingBegins.get(report.bracketId)?.hold();
        return;
      case "bracketOpened":
        window?.pendingBegins.get(report.bracketId)?.finish("opened");
        return;
    }
  }

  /** `before-mouse-event` of a guest: classifies a press before focus moves. */
  handleGuestMouse(entry: BrowserViewEntry, mouse: MouseInputEvent): void {
    if (mouse.type !== "mouseDown" || this.ownPress) return;
    const window = this.windows.get(entry.identity.lifecycleWindowId);
    if (window === undefined) return;
    const tab = this.tabs.get(entry);
    if (tab !== undefined) {
      if (tab.injecting !== null) {
        tab.pressSeen = true;
        tab.lastPressByAgent = true;
        return;
      }
      if (tab.pressTokens > 0) {
        tab.pressTokens -= 1;
        tab.lastPressByAgent = true;
        return;
      }
      tab.lastPressByAgent = false;
    }
    window.owner = entry;
    window.personTook = entry;
    window.parkedIn = null;
    // An agent input in flight may still take focus from here, and a hand-back
    // needs this tile's debugger, which taking the lease attaches at once.
    const held =
      window.inputs > 0 && !isAgentTab(entry)
        ? this.holdOwner(entry)
        : Promise.resolve();
    // Sent ahead of the move it explains, on the channel the move uses.
    if (tab !== undefined && tab.inFlight > 0) {
      this.signal(window, {
        kind: "personPress",
        registrationId: entry.identity.registrationId,
      });
    }
    this.syncThenReleaseIfIdle(window, held);
  }

  /** `input-event` of a guest, which follows the focus move in the same task. */
  handleGuestInput(entry: BrowserViewEntry, input: InputEvent): void {
    if (input.type !== "mouseDown" || this.ownPress) return;
    if (this.tabs.get(entry)?.lastPressByAgent !== true) return;
    const window = this.windows.get(entry.identity.lifecycleWindowId);
    if (window === undefined || !this.isActive(window)) return;
    if (this.isStolen(window, entry)) this.handBack(window);
  }

  /**
   * `before-input-event` of a guest. A key the person typed while an agent's
   * press, or a hand-back that could not land, left focus in this tab goes to
   * the owner instead; true when the key was taken.
   */
  redirectStrayKey(entry: BrowserViewEntry, input: Input): boolean {
    if (input.type !== "keyDown" && input.type !== "keyUp") return false;
    const tab = this.tabs.get(entry);
    if (tab === undefined || tab.injecting !== null) return false;
    const window = this.windows.get(entry.identity.lifecycleWindowId);
    if (window === undefined || window.personTook === entry) return false;
    if (tab.pressesInFlight === 0 && window.parkedIn !== entry) return false;
    if (window.owner === entry) return false;
    const owner = this.debuggerFor(window, window.owner);
    if (owner === null) return false;
    this.handBack(window);
    void owner
      .sendCommand("Input.dispatchKeyEvent", strayKeyParams(input), undefined)
      .catch(() => undefined);
    return true;
  }

  /** Whether a tile's `focus` came from an agent, so it must not activate its pane. */
  suppressesTileFocus(entry: BrowserViewEntry): boolean {
    const tab = this.tabs.get(entry);
    const window = this.windows.get(entry.identity.lifecycleWindowId);
    if (tab === undefined || window === undefined) return false;
    if (window.personTook === entry) return false;
    return (
      tab.inFlight > 0 ||
      window.parkedIn === entry ||
      this.holder(window) !== entry
    );
  }

  forget(entry: BrowserViewEntry): void {
    const tab = this.tabs.get(entry);
    this.tabs.delete(entry);
    tab?.ownerLease?.release();
    const window = this.windows.get(entry.identity.lifecycleWindowId);
    if (window === undefined) return;
    for (const pending of Array.from(window.pendingBegins.values())) {
      if (pending.entry === entry) pending.finish("abandoned");
    }
    if (window.owner === entry) window.owner = "app";
    if (window.personTook === entry) window.personTook = null;
    if (window.parkedIn === entry) window.parkedIn = null;
    this.releaseIfIdle(window);
  }

  dispose(): void {
    for (const window of Array.from(this.windows.values())) {
      this.disposeWindow(window);
    }
    for (const tab of this.tabs.values()) tab.ownerLease?.release();
    this.tabs.clear();
  }

  private async prepare(
    window: WindowFocus,
    entry: BrowserViewEntry,
    session: BrowserDebugSession,
  ): Promise<void> {
    const tab = this.tabFor(entry);
    const attachment = session.attachment();
    if (tab.preparedAttachment !== attachment && session.isReady()) {
      tab.preparedAttachment = attachment;
      await Promise.all([
        session.sendCommand(
          "Emulation.setFocusEmulationEnabled",
          { enabled: true },
          undefined,
        ),
        giveFocusedFrame(session),
      ]).catch((error: unknown) => {
        log.warn("[browser-view] agent tab focus setup failed", {
          error: describeLogError(error),
        });
      });
    }
    const owner = this.resolveOwner(window);
    if (owner !== "app" && owner !== entry && !isAgentTab(owner)) {
      await this.holdOwner(owner);
    }
    await this.syncEmulation(window);
  }

  /**
   * Leases the debugger of an owner tile no agent drives, so focus can be
   * handed back to it. `ready` attaches before its first wait.
   */
  private holdOwner(owner: BrowserViewEntry): Promise<void> {
    const ownerTab = this.tabFor(owner);
    try {
      ownerTab.ownerLease ??= this.debugSessions.ensure(owner).acquire();
    } catch (error) {
      // A tile being closed: there is nothing to hand focus back to.
      log.warn("[browser-view] owner tile debugger unavailable", {
        error: describeLogError(error),
      });
      return Promise.resolve();
    }
    return ownerTab.ownerLease.ready().catch(() => undefined);
  }

  private inject(
    window: WindowFocus,
    entry: BrowserViewEntry,
    tab: TabFocus,
    kind: "press" | "key" | "pointer",
    send: () => Promise<unknown>,
  ): Promise<unknown> {
    const active = this.isActive(window);
    tab.injecting = kind === "press" ? "press" : "input";
    tab.pressSeen = false;
    try {
      // A key goes where focus is, and an event injected into a window that is
      // behind first focuses its page: both start with focus in the tab.
      if (
        window.owner !== entry &&
        (kind === "key" || !active) &&
        this.holder(window) !== entry
      ) {
        void this.pressWithoutButton(window, entry);
      }
      const done = send();
      if (active && this.isStolen(window, entry)) this.handBack(window);
      if (this.isStolen(window, entry)) window.parkedIn = entry;
      return done;
    } finally {
      tab.injecting = null;
      if (kind === "press" && !tab.pressSeen) tab.pressTokens += 1;
    }
  }

  private begin(
    window: WindowFocus,
    entry: BrowserViewEntry,
    bracketId: string,
  ): Promise<BeginOutcome> {
    const { promise, resolve } = Promise.withResolvers<BeginOutcome>();
    const finish = (outcome: BeginOutcome): void => {
      clearTimeout(timer);
      window.pendingBegins.delete(bracketId);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish("abandoned");
    }, BEGIN_ACK_DEADLINE_MS);
    window.pendingBegins.set(bracketId, {
      entry,
      hold: () => {
        clearTimeout(timer);
      },
      finish,
    });
    const sent = this.signal(window, {
      kind: "begin",
      bracketId,
      registrationId: entry.identity.registrationId,
      agentRegistrationIds: this.agentRegistrationIds(window),
    });
    if (!sent || !this.guardedWindows.has(window.windowId)) finish("unguarded");
    return promise;
  }

  private signal(
    window: WindowFocus,
    signal: BrowserViewAgentFocusSignal,
  ): boolean {
    return this.send(
      window.windowId,
      RunnerHostEvent.browserViewAgentFocusSignal,
      signal,
    );
  }

  /** The tile holding the window's keyboard focus, read from Chromium's own state. */
  private holder(window: WindowFocus): FocusOwner {
    for (const entry of this.windowEntries(window)) {
      if (entry.webContents.focusedFrame !== null) return entry;
    }
    return "app";
  }

  private resolveOwner(window: WindowFocus): FocusOwner {
    const holder = this.holder(window);
    const stolen =
      holder !== "app" &&
      isAgentTab(holder) &&
      window.personTook !== holder &&
      ((this.tabs.get(holder)?.pressesInFlight ?? 0) > 0 ||
        window.parkedIn === holder);
    if (!stolen) {
      window.owner = holder;
      window.parkedIn = null;
    }
    return window.owner;
  }

  private isStolen(window: WindowFocus, entry: BrowserViewEntry): boolean {
    return window.owner !== entry && this.holder(window) === entry;
  }

  private handBack(window: WindowFocus): void {
    // Another user of the app page's debugger may have detached it mid-input.
    if (window.owner === "app" && !this.ensureHost(window)) return;
    window.handedBack = this.pressWithoutButton(window, window.owner);
  }

  /** A closed window is not focused, and is not asked. */
  private isActive(window: WindowFocus): boolean {
    return !window.window.isDestroyed() && window.window.isFocused();
  }

  /** Moves focus into `target`'s page; answered once that page has handled it. */
  private pressWithoutButton(
    window: WindowFocus,
    target: FocusOwner,
  ): Promise<void> {
    const browserDebugger = this.debuggerFor(window, target);
    if (browserDebugger === null) return Promise.resolve();
    this.ownPress = true;
    try {
      const answers = (["mousePressed", "mouseReleased"] as const).map((type) =>
        browserDebugger
          .sendCommand(
            "Input.dispatchMouseEvent",
            { type, ...OFF_VIEW_POINT, button: "none" },
            undefined,
          )
          .then(
            () => undefined,
            () => undefined,
          ),
      );
      return Promise.all(answers).then(() => undefined);
    } catch (error) {
      log.warn("[browser-view] focus hand-back failed", {
        error: describeLogError(error),
      });
      return Promise.resolve();
    } finally {
      this.ownPress = false;
    }
  }

  private debuggerFor(
    window: WindowFocus,
    target: FocusOwner,
  ): BrowserViewDebugger | null {
    const contents = target === "app" ? window.app : target.webContents;
    if (contents.isDestroyed() || !contents.debugger.isAttached()) return null;
    return contents.debugger;
  }

  /** Emulation on the owner while the window is focused; agent tabs keep theirs. */
  private async syncEmulation(window: WindowFocus): Promise<void> {
    const focused = this.isActive(window);
    const work: Promise<unknown>[] = [];
    const appWanted = focused && window.owner === "app";
    if (
      window.appEmulated !== appWanted &&
      this.debuggerFor(window, "app") !== null
    ) {
      window.appEmulated = appWanted;
      work.push(
        window.app.debugger.sendCommand(
          "Emulation.setFocusEmulationEnabled",
          { enabled: appWanted },
          undefined,
        ),
      );
    }
    for (const entry of this.windowEntries(window)) {
      const tab = this.tabs.get(entry);
      if (tab === undefined || tab.ownerLease === null) continue;
      // An owner tile an agent has since started driving keeps the
      // emulation every agent tab has.
      const wanted = isAgentTab(entry) || (focused && window.owner === entry);
      const session = entry.debugSession;
      if (tab.ownerEmulated === wanted || session === null) continue;
      if (!session.isReady()) continue;
      tab.ownerEmulated = wanted;
      work.push(
        session.sendCommand(
          "Emulation.setFocusEmulationEnabled",
          { enabled: wanted },
          undefined,
        ),
      );
    }
    await Promise.all(work).catch(() => undefined);
  }

  private windowFocus(windowId: string): WindowFocus | null {
    const known = this.windows.get(windowId);
    if (known !== undefined) return known;
    const window = this.getWindow(windowId);
    if (window === null || window.isDestroyed()) return null;
    const app = window.webContents;
    if (app.isDestroyed()) return null;
    const onFocus = (): void => {
      this.handleWindowFocus(state);
    };
    const onBlur = (): void => {
      void this.syncEmulation(state);
    };
    const onClosed = (): void => {
      this.disposeWindow(state);
    };
    const onAppMouse = (_event: unknown, mouse: MouseInputEvent): void => {
      if (mouse.type !== "mouseDown" || this.ownPress) return;
      state.owner = "app";
      state.personTook = null;
      state.parkedIn = null;
      this.syncThenReleaseIfIdle(state, Promise.resolve());
    };
    // Detached by someone else, DevTools opening included: what the guard
    // attached and put on it is gone, and a later attachment is not its own.
    const onHostDetach = (): void => {
      state.hostAttachedByGuard = false;
      state.appEmulated = false;
    };
    const onAppNavigation = (
      _event: unknown,
      _url: string,
      isInPlace: boolean,
      isMainFrame: boolean,
    ): void => {
      if (isMainFrame && !isInPlace) this.resetPage(state);
    };
    // Again at commit: a report the old page sent before it was replaced is
    // read by then, and the new page's own comes after.
    const onAppCommit = (): void => {
      this.resetPage(state);
    };
    const onAppGone = (): void => {
      this.resetPage(state);
    };
    window.on("focus", onFocus);
    window.on("blur", onBlur);
    window.on("closed", onClosed);
    app.on("before-mouse-event", onAppMouse);
    app.on("did-start-navigation", onAppNavigation);
    app.on("did-navigate", onAppCommit);
    app.on("render-process-gone", onAppGone);
    app.debugger.on("detach", onHostDetach);
    const state: WindowFocus = {
      windowId,
      window,
      app,
      owner: "app",
      personTook: null,
      parkedIn: null,
      hostAttachedByGuard: false,
      inputs: 0,
      handedBack: Promise.resolve(),
      appEmulated: false,
      pendingBegins: new Map(),
      removeListeners: () => {
        window.off("focus", onFocus);
        window.off("blur", onBlur);
        window.off("closed", onClosed);
        if (app.isDestroyed()) return;
        app.off("before-mouse-event", onAppMouse);
        app.off("did-start-navigation", onAppNavigation);
        app.off("did-navigate", onAppCommit);
        app.off("render-process-gone", onAppGone);
        app.debugger.off("detach", onHostDetach);
      },
    };
    this.windows.set(windowId, state);
    return state;
  }

  /** Back from another app: focus goes to the owner before any key arrives. */
  private handleWindowFocus(window: WindowFocus): void {
    const holder = this.holder(window);
    if (
      holder !== "app" &&
      holder !== window.owner &&
      isAgentTab(holder) &&
      window.personTook !== holder &&
      this.ensureHost(window)
    ) {
      this.handBack(window);
    }
    window.parkedIn = null;
    this.syncThenReleaseIfIdle(window, Promise.resolve());
  }

  /** After a person's own focus change: emulation follows it, and an idle guard lets go. */
  private syncThenReleaseIfIdle(
    window: WindowFocus,
    ownerReady: Promise<void>,
  ): void {
    void ownerReady
      .then(() => this.syncEmulation(window))
      .then(() => {
        this.releaseIfIdle(window);
      });
  }

  /** Attaches the host page's debugger; false leaves the window unguarded. */
  private ensureHost(window: WindowFocus): boolean {
    if (window.app.isDestroyed()) return false;
    const browserDebugger = window.app.debugger;
    if (browserDebugger.isAttached()) return true;
    try {
      browserDebugger.attach("1.3");
    } catch (error) {
      log.warn("[browser-view] agent focus guard could not attach", {
        error: describeLogError(error),
      });
      return false;
    }
    window.hostAttachedByGuard = true;
    window.appEmulated = false;
    return true;
  }

  private releaseIfIdle(window: WindowFocus): void {
    if (this.windows.get(window.windowId) !== window) return;
    if (window.inputs > 0 || window.parkedIn !== null) return;
    this.release(window);
  }

  private release(window: WindowFocus): void {
    this.releaseOwnerLeases(window);
    const attachedByGuard = window.hostAttachedByGuard;
    const emulated = window.appEmulated;
    window.hostAttachedByGuard = false;
    window.appEmulated = false;
    if (window.app.isDestroyed() || !window.app.debugger.isAttached()) return;
    if (!attachedByGuard) {
      // Someone else's attachment stays; what the guard put on it comes off.
      if (emulated) {
        void window.app.debugger
          .sendCommand(
            "Emulation.setFocusEmulationEnabled",
            { enabled: false },
            undefined,
          )
          .catch(() => undefined);
      }
      return;
    }
    try {
      window.app.debugger.detach();
    } catch (error) {
      log.warn("[browser-view] agent focus guard detach failed", {
        error: describeLogError(error),
      });
    }
  }

  private releaseOwnerLeases(window: WindowFocus): void {
    for (const entry of this.windowEntries(window)) {
      const tab = this.tabs.get(entry);
      if (tab === undefined || tab.ownerLease === null) continue;
      if (
        tab.ownerEmulated &&
        !isAgentTab(entry) &&
        entry.debugSession?.isReady() === true
      ) {
        void entry.debugSession
          .sendCommand(
            "Emulation.setFocusEmulationEnabled",
            { enabled: false },
            undefined,
          )
          .catch(() => undefined);
      }
      tab.ownerEmulated = false;
      tab.ownerLease.release();
      tab.ownerLease = null;
    }
  }

  /**
   * The page is going, or stopped its guard: nothing it holds will answer,
   * and a page that runs the guard says so again.
   */
  private resetPage(window: WindowFocus): void {
    this.guardedWindows.delete(window.windowId);
    for (const pending of Array.from(window.pendingBegins.values())) {
      pending.finish("abandoned");
    }
  }

  private disposeWindow(window: WindowFocus): void {
    if (this.windows.get(window.windowId) !== window) return;
    this.windows.delete(window.windowId);
    window.removeListeners();
    this.resetPage(window);
    this.release(window);
  }

  private agentRegistrationIds(window: WindowFocus): string[] {
    const ids: string[] = [];
    for (const entry of this.windowEntries(window)) {
      if (isAgentTab(entry)) ids.push(entry.identity.registrationId);
    }
    return ids;
  }

  private *windowEntries(window: WindowFocus): Generator<BrowserViewEntry> {
    for (const entry of this.entries.guestValues()) {
      if (entry.identity.lifecycleWindowId !== window.windowId) continue;
      if (entry.closePromise !== null || entry.webContents.isDestroyed()) {
        continue;
      }
      yield entry;
    }
  }

  private tabFor(entry: BrowserViewEntry): TabFocus {
    const known = this.tabs.get(entry);
    if (known !== undefined) return known;
    const tab: TabFocus = {
      inFlight: 0,
      pressesInFlight: 0,
      injecting: null,
      pressSeen: false,
      pressTokens: 0,
      lastPressByAgent: false,
      preparedAttachment: null,
      ownerLease: null,
      ownerEmulated: false,
    };
    this.tabs.set(entry, tab);
    return tab;
  }
}

function isAgentTab(entry: BrowserViewEntry): boolean {
  return entry.agentCdpLease !== null;
}

/**
 * Gives the tab's frame tree a focused frame. A tab focus moves into without
 * a press Blink handles has none, and `focusedFrame` is how the guard tells
 * which tile holds focus. `window.focus()` sets it without taking page focus;
 * an isolated world keeps it out of the page's reach.
 */
async function giveFocusedFrame(session: BrowserDebugSession): Promise<void> {
  const tree = await session.sendCommand("Page.getFrameTree", {}, undefined);
  const frameId = readMainFrameId(tree);
  if (frameId === null) return;
  const world = await session.sendCommand(
    "Page.createIsolatedWorld",
    { frameId, worldName: FOCUS_WORLD_NAME },
    undefined,
  );
  const contextId = readNumberField(world, "executionContextId");
  if (contextId === null) return;
  await session.sendCommand(
    "Runtime.evaluate",
    { expression: "window.focus()", contextId },
    undefined,
  );
}

function readMainFrameId(tree: unknown): string | null {
  if (typeof tree !== "object" || tree === null) return null;
  if (!("frameTree" in tree)) return null;
  const frameTree = tree.frameTree;
  if (typeof frameTree !== "object" || frameTree === null) return null;
  if (!("frame" in frameTree)) return null;
  const frame = frameTree.frame;
  if (typeof frame !== "object" || frame === null || !("id" in frame)) {
    return null;
  }
  return typeof frame.id === "string" ? frame.id : null;
}

function readNumberField(value: unknown, field: string): number | null {
  if (typeof value !== "object" || value === null || !(field in value)) {
    return null;
  }
  const read: unknown = Reflect.get(value, field);
  return typeof read === "number" ? read : null;
}

/** A redirected key arrives as a plain key: no repeat, location or keypad bit. */
function strayKeyParams(input: Input): Record<string, unknown> {
  const modifiers =
    (input.alt ? 1 : 0) |
    (input.control ? 2 : 0) |
    (input.meta ? 4 : 0) |
    (input.shift ? 8 : 0);
  const base = { key: input.key, code: input.code, modifiers };
  if (input.type === "keyUp") return { type: "keyUp", ...base };
  const printable = input.key.length === 1 && !input.control && !input.meta;
  return printable
    ? { type: "keyDown", text: input.key, ...base }
    : { type: "rawKeyDown", ...base };
}
