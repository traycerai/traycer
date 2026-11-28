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
   * input moved focus, from what the guard did rather than what Chromium
   * reports, so no other input reads that tab as the person's. App code can
   * move focus out of it unseen, so it decides only an extra hand-back, never
   * where an input is sent.
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
   * Answered once the owner's page has applied the last hand-back: the
   * emulation that hid the move comes off only after it.
   */
  handedBack: Promise<void>;
  /**
   * The same, for the last hand-back to the app page. Chromium sets page focus
   * on a page's input channel, which is not ordered with the one `end` takes,
   * and answers an injected press only after the page handled it: a bracket
   * closes after this, so no page focus change can reach the page after its
   * `end`. A hand-back to a tile changes no page focus of the app page's.
   */
  appHandedBack: Promise<void>;
  /**
   * Resolved once the app page is replaced or its renderer is gone, and left
   * resolved until the next page commits: Chromium answers no input sent to a
   * page whose renderer is gone, so a hand-back to it is not waited on.
   */
  pageEnded: PromiseWithResolvers<void>;
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
  /** Agent presses on this tab until CDP answers them. */
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
  /**
   * Agent presses that moved no focus during their dispatch, oldest first,
   * each with what closes its bracket. Chromium may still deliver one (the
   * first press into a page after it loads, or one into a cross-site frame),
   * and nothing in main reports that: the window's page does when focus
   * leaves it (`tileTookFocus`), and each press's answer bounds the rest.
   */
  unsettled: Array<() => void>;
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
  /**
   * Windows whose page said it runs the guard. `replaced`: that page was
   * replaced or lost, and the next has not said so yet; nothing is sent there
   * meanwhile. A window not listed runs no guard, and is not waited on.
   */
  private readonly guards = new Map<string, "running" | "replaced">();
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
      // A window whose page runs the guard never gets an unguarded input.
      if (this.guards.has(entry.identity.lifecycleWindowId)) {
        return notSent(command);
      }
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
      // The emulation that hid the last hand-back's move comes off once that
      // move is applied, a tile's included.
      this.afterLastHandBack(window, () => {
        this.releaseIfIdle(window);
      });
    }
  }

  private async bracketed(
    window: WindowFocus,
    entry: BrowserViewEntry,
    session: BrowserDebugSession,
    target: BrowserCdpTarget,
    command: BrowserCdpInputCommand,
  ): Promise<BrowserCdpResult> {
    // Preparation waits: the tab or its window may have closed meanwhile.
    if (!this.isLive(window, entry)) return notSent(command);
    const tab = this.tabFor(entry);
    const kind =
      command.kind !== "cdpDispatchMouseEvent"
        ? "key"
        : command.type === "mousePressed"
          ? "press"
          : "pointer";
    // Resolved once the input has moved focus wherever it will, and moved it back.
    const moved = Promise.withResolvers<void>();
    let closed = Promise.resolve();
    if (kind === "press") tab.pressesInFlight += 1;
    try {
      return await session.dispatchAround(target, command, async (send) => {
        // After any frame routing: the page holds focus events back only
        // around the input itself.
        const bracketId = randomUUID();
        const opened =
          (await this.begin(window, entry, bracketId)) !== "abandoned";
        if (opened) tab.inFlight += 1;
        // Closed once the move is handed back, not when the agent's page
        // answers, which a slow or hung page may not do for long. One not
        // opened is closed too, for a page that opens it late: a stalled one,
        // or one whose composition ends.
        closed = moved.promise
          .then(() => window.appHandedBack)
          .then(() => {
            if (opened) tab.inFlight -= 1;
            this.signal(window, { kind: "end", bracketId });
          });
        if (!opened) throw new Error(NOT_SENT_MESSAGE);
        return this.inject(window, entry, tab, kind, moved.resolve, send);
      });
    } finally {
      if (kind === "press") {
        tab.pressesInFlight -= 1;
        if (tab.pressesInFlight === 0) tab.pressTokens = 0;
        const at = tab.unsettled.indexOf(moved.resolve);
        if (at !== -1) tab.unsettled.splice(at, 1);
        if (this.isActive(window) && this.isStolen(window, entry)) {
          this.handBack(window);
        }
      }
      if (this.isStolen(window, entry)) window.parkedIn = entry;
      else if (window.parkedIn === entry) window.parkedIn = null;
      moved.resolve();
      await closed;
    }
  }

  report(windowId: string, report: BrowserViewAgentFocusReport): void {
    const window = this.windows.get(windowId);
    switch (report.kind) {
      case "guardStarted":
        this.guards.set(windowId, "running");
        return;
      case "guardStopped":
        this.guards.delete(windowId);
        if (window !== undefined) abandonBegins(window);
        return;
      // An answer for a bracket no longer pending, from a page since replaced
      // included, changes nothing.
      case "bracketHeld":
        window?.pendingBegins.get(report.bracketId)?.hold();
        return;
      case "bracketOpened":
        window?.pendingBegins.get(report.bracketId)?.finish("opened");
        return;
      case "tileTookFocus":
        if (window !== undefined) {
          this.handleTileTookFocus(window, report.registrationId);
        }
        return;
    }
  }

  /**
   * The window's page saw focus leave it for a tile inside a bracket. Acted
   * on only once Chromium reads focus in that tab: a word about a press
   * already handed back finds it elsewhere, and leaves a later one waiting.
   */
  private handleTileTookFocus(
    window: WindowFocus,
    registrationId: string,
  ): void {
    const entry = Array.from(this.windowEntries(window)).find(
      (candidate) => candidate.identity.registrationId === registrationId,
    );
    if (entry === undefined) return;
    const tab = this.tabs.get(entry);
    if (tab === undefined || tab.unsettled.length === 0) return;
    if (this.holder(window) !== entry) return;
    if (window.owner !== entry) this.handBackOrPark(window, entry);
    tab.unsettled.shift()?.();
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

  /**
   * `input-event` of a guest: an agent press that has moved focus by then
   * goes back at once. One into a cross-site frame may not have yet. One
   * still being dispatched is `inject`'s, which reads the move in this task.
   */
  handleGuestInput(entry: BrowserViewEntry, input: InputEvent): void {
    if (input.type !== "mouseDown" || this.ownPress) return;
    const tab = this.tabs.get(entry);
    if (tab?.lastPressByAgent !== true || tab.injecting !== null) return;
    const window = this.windows.get(entry.identity.lifecycleWindowId);
    if (window === undefined || !this.isActive(window)) return;
    if (this.isStolen(window, entry)) this.handBack(window);
  }

  /**
   * `before-input-event` of a guest. A key the person typed while an agent's
   * press, or a hand-back that could not land, left focus in this tab goes to
   * the owner instead, or nowhere while the owner cannot be reached; true
   * when the key was taken.
   */
  redirectStrayKey(entry: BrowserViewEntry, input: Input): boolean {
    if (input.type !== "keyDown" && input.type !== "keyUp") return false;
    const tab = this.tabs.get(entry);
    if (tab === undefined || tab.injecting !== null) return false;
    const window = this.windows.get(entry.identity.lifecycleWindowId);
    if (window === undefined || window.personTook === entry) return false;
    if (tab.pressesInFlight === 0 && window.parkedIn !== entry) return false;
    if (window.owner === entry) return false;
    // A detached app page is attached again, as a hand-back would.
    const reachable = window.owner !== "app" || this.ensureHost(window);
    const owner = reachable ? this.debuggerFor(window, window.owner) : null;
    // Meant for the owner, so never for the agent's page: held back.
    if (owner === null) return true;
    const parked = window.parkedIn === entry;
    this.handBack(window);
    void owner
      .sendCommand("Input.dispatchKeyEvent", strayKeyParams(input), undefined)
      .catch(() => undefined);
    if (parked) this.settleParked(window);
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
    // A closed tab moves no focus.
    for (const unsettled of tab?.unsettled.splice(0) ?? []) unsettled();
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
      try {
        await Promise.all([
          session.sendCommand(
            "Emulation.setFocusEmulationEnabled",
            { enabled: true },
            undefined,
          ),
          giveFocusedFrame(session),
        ]);
        tab.preparedAttachment = attachment;
      } catch (error) {
        // Tried again on the tab's next input.
        log.warn("[browser-view] agent tab focus setup failed", {
          error: describeLogError(error),
        });
      }
    }
    const owner = this.resolveOwner(window);
    if (owner !== "app" && owner !== entry && !isAgentTab(owner)) {
      await this.holdOwner(owner);
    }
    await this.syncEmulation(window);
  }

  /**
   * Attaches the debugger of an owner tile no agent drives, so focus can be
   * handed back to it. Bare: it enables no domain, so the person's page sees
   * nothing an automation client would leave. Attached by the time it returns.
   */
  private holdOwner(owner: BrowserViewEntry): Promise<void> {
    const ownerTab = this.tabFor(owner);
    try {
      ownerTab.ownerLease ??= this.debugSessions.ensure(owner).acquireBare();
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
    moved: () => void,
    send: () => Promise<unknown>,
  ): Promise<unknown> {
    // The tab may have closed while its bracket opened.
    if (!this.isLive(window, entry)) throw new Error(NOT_SENT_MESSAGE);
    // Where the person's focus is now, not where it was when this was
    // prepared: a key of theirs may have moved it since.
    const owner = this.resolveOwner(window);
    if (owner !== "app" && owner !== entry && !isAgentTab(owner)) {
      void this.holdOwner(owner);
    }
    const active = this.isActive(window);
    tab.injecting = kind === "press" ? "press" : "input";
    tab.pressSeen = false;
    let sent = false;
    let settled = true;
    try {
      // A key goes where focus is, and an event injected into a window that is
      // behind first focuses its page: both start with focus in the tab. Read
      // from Chromium only: a tab parked as holding focus may have lost it to
      // app code, and a key sent without moving in lands wherever it went.
      const moveIn =
        window.owner !== entry &&
        (kind === "key" || !active) &&
        this.focusedTile(window) !== entry;
      // Not sent where it would land: a key would reach the person's owner.
      if (moveIn && this.pressWithoutButton(window, entry) === null) {
        throw new Error(NOT_SENT_MESSAGE);
      }
      const done = send();
      sent = true;
      // The guard's own press is known to have moved it here, whatever
      // Chromium reads.
      const tookFocus = moveIn || this.focusedTile(window) === entry;
      if (window.owner !== entry && tookFocus)
        this.handBackOrPark(window, entry);
      // A press seen to move nothing yet still may: Chromium can deliver it
      // after this returns.
      settled = kind !== "press" || tookFocus || window.owner === entry;
      return done;
    } finally {
      tab.injecting = null;
      if (kind === "press" && sent && !tab.pressSeen) tab.pressTokens += 1;
      if (settled) moved();
      else tab.unsettled.push(moved);
    }
  }

  /** Focus an agent input moved into `entry` goes back, or waits there until it can. */
  private handBackOrPark(window: WindowFocus, entry: BrowserViewEntry): void {
    if (this.isActive(window) && this.handBack(window)) return;
    window.parkedIn = entry;
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
    const guard = this.guards.get(window.windowId);
    if (guard === undefined) finish("unguarded");
    else if (guard === "replaced" || !sent) finish("abandoned");
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

  /** The tile Chromium reads as holding the window's keyboard focus. */
  private focusedTile(window: WindowFocus): BrowserViewEntry | null {
    for (const entry of this.windowEntries(window)) {
      if (entry.webContents.focusedFrame !== null) return entry;
    }
    return null;
  }

  /**
   * Where focus is: the tile Chromium reads as holding it, else the tab it was
   * parked in. Never for where an input goes: a wrong yes here costs only an
   * extra hand-back (`parkedIn`).
   */
  private holder(window: WindowFocus): FocusOwner {
    return this.focusedTile(window) ?? window.parkedIn ?? "app";
  }

  private resolveOwner(window: WindowFocus): FocusOwner {
    // Chromium's reading: focus app code moved out of a parked tab is the app's.
    const holder = this.focusedTile(window) ?? "app";
    const stolen =
      holder !== "app" &&
      window.personTook !== holder &&
      (window.parkedIn === holder ||
        (isAgentTab(holder) &&
          (this.tabs.get(holder)?.pressesInFlight ?? 0) > 0));
    if (!stolen) {
      window.owner = holder;
      window.parkedIn = null;
      // Focus seen elsewhere, moved there by the person's keyboard or app
      // code: their last press no longer says where it belongs.
      if (window.personTook !== holder) window.personTook = null;
    }
    return window.owner;
  }

  private isStolen(window: WindowFocus, entry: BrowserViewEntry): boolean {
    return window.owner !== entry && this.holder(window) === entry;
  }

  /** Moves focus to the owner; false when that could not be sent, and focus stays put. */
  private handBack(window: WindowFocus): boolean {
    // Another user of the app page's debugger may have detached it mid-input.
    if (window.owner === "app" && !this.ensureHost(window)) return false;
    const answered = this.pressWithoutButton(window, window.owner);
    if (answered === null) return false;
    if (window.owner === "app") {
      const applied = Promise.race([answered, window.pageEnded.promise]);
      window.handedBack = applied;
      window.appHandedBack = applied;
    } else {
      // A tile's closing detaches its debugger, which answers it.
      window.handedBack = answered;
    }
    window.parkedIn = null;
    return true;
  }

  /** Runs `then` once the last hand-back, and any made while it is awaited, is applied. */
  private afterLastHandBack(window: WindowFocus, then: () => void): void {
    const last = window.handedBack;
    void last.then(() => {
      if (window.handedBack === last) then();
      else this.afterLastHandBack(window, then);
    });
  }

  /** A closed window is not focused, and is not asked. */
  private isActive(window: WindowFocus): boolean {
    return !window.window.isDestroyed() && window.window.isFocused();
  }

  /**
   * Moves focus into `target`'s page; answered once that page has handled it.
   * Null when it could not be sent.
   */
  private pressWithoutButton(
    window: WindowFocus,
    target: FocusOwner,
  ): Promise<void> | null {
    const browserDebugger = this.debuggerFor(window, target);
    if (browserDebugger === null) return null;
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
      return null;
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
      if (tab.ownerEmulated === wanted) continue;
      // Sent on the bare attachment the lease holds: no domain gates it.
      const browserDebugger = this.debuggerFor(window, entry);
      if (browserDebugger === null) continue;
      tab.ownerEmulated = wanted;
      work.push(
        browserDebugger.sendCommand(
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
    // At commit, not at the start: until then the old page still runs, and
    // can answer, and a navigation that does not commit leaves it running.
    // Whatever the old page sent is read by commit; the new page's comes after.
    const onAppCommit = (): void => {
      this.replacePage(state);
      state.pageEnded = Promise.withResolvers<void>();
    };
    const onAppGone = (): void => {
      this.replacePage(state);
    };
    window.on("focus", onFocus);
    window.on("blur", onBlur);
    window.on("closed", onClosed);
    app.on("before-mouse-event", onAppMouse);
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
      appHandedBack: Promise.resolve(),
      pageEnded: Promise.withResolvers<void>(),
      appEmulated: false,
      pendingBegins: new Map(),
      removeListeners: () => {
        window.off("focus", onFocus);
        window.off("blur", onBlur);
        window.off("closed", onClosed);
        if (app.isDestroyed()) return;
        app.off("before-mouse-event", onAppMouse);
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
    if (this.strayHolder(window) !== null) this.handBack(window);
    this.settleParked(window);
  }

  /**
   * After a hand-back that may not have been sent: a tab still holding focus
   * stays parked, and keeps the guard; otherwise an idle guard lets go once
   * the owner's page has the focus.
   */
  private settleParked(window: WindowFocus): void {
    window.parkedIn = this.strayHolder(window);
    this.afterLastHandBack(window, () => {
      void this.syncEmulation(window).then(() => {
        this.releaseIfIdle(window);
      });
    });
  }

  /** A tile holding focus an agent's input left there: parked, or an agent's read as holding it. */
  private strayHolder(window: WindowFocus): BrowserViewEntry | null {
    const holder = this.holder(window);
    if (holder === "app" || holder === window.owner) return null;
    if (window.personTook === holder) return null;
    return window.parkedIn === holder || isAgentTab(holder) ? holder : null;
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
      if (tab.ownerEmulated && !isAgentTab(entry)) {
        void this.debuggerFor(window, entry)
          ?.sendCommand(
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
   * The app page was replaced or lost: nothing it held will answer, a bracket
   * it opened no longer holds, and until the next page says it runs the
   * guard no input is sent into this window.
   */
  private replacePage(window: WindowFocus): void {
    if (this.guards.has(window.windowId)) {
      this.guards.set(window.windowId, "replaced");
    }
    window.pageEnded.resolve();
    abandonBegins(window);
  }

  private disposeWindow(window: WindowFocus): void {
    if (this.windows.get(window.windowId) !== window) return;
    this.windows.delete(window.windowId);
    window.removeListeners();
    this.guards.delete(window.windowId);
    window.pageEnded.resolve();
    abandonBegins(window);
    this.release(window);
  }

  /** The tab still open, in a window still guarded here. */
  private isLive(window: WindowFocus, entry: BrowserViewEntry): boolean {
    return (
      this.windows.get(window.windowId) === window &&
      entry.closePromise === null &&
      !entry.webContents.isDestroyed()
    );
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
      unsettled: [],
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

const NOT_SENT_MESSAGE =
  "Input not sent: the app window was reloading or not responding, or the tab closed";

/** What an agent gets for an input that was not sent; it can retry it. */
function notSent(command: BrowserCdpInputCommand): BrowserCdpResult {
  return {
    kind: command.kind,
    ok: false,
    error: { kind: "cdp_error", message: NOT_SENT_MESSAGE, code: null },
  };
}

function abandonBegins(window: WindowFocus): void {
  for (const pending of Array.from(window.pendingBegins.values())) {
    pending.finish("abandoned");
  }
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
