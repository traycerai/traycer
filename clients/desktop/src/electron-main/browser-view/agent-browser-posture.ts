import { describeLogError, log } from "../app/logger";

export interface AgentBrowserPostureDebugger {
  isAttached(): boolean;
  attach(protocolVersion: string): void;
  sendCommand(
    method: string,
    commandParams: Record<string, unknown>,
    sessionId: string | undefined,
  ): Promise<unknown>;
}

export interface AgentBrowserPostureWebContents {
  readonly debugger: AgentBrowserPostureDebugger;
  isDestroyed(): boolean;
  on(event: "did-navigate", listener: () => void): void;
}

/**
 * Ticket 15 P1-2: whether a tile's agent access has ended, keyed by the
 * webContents identity `applyAgentBrowserBackgroundPosture` was called with.
 *
 * This attaches the debugger independently of `BrowserDebugSession`, and
 * keeps re-attaching it on every `did-navigate` - so a released tile that
 * navigates during its reuse grace window would otherwise have its debugger
 * silently re-attached by this keepalive, undoing the release. `releaseTile`
 * marks an entry here before it resolves; `cancelRelease` clears it on
 * reclaim. A webContents that never went through
 * `applyAgentBrowserBackgroundPosture` (a borrowed tile, not an agent-owned
 * one) has no entry here, so `setAgentBrowserPostureReleased` is a no-op for
 * it - `BrowserViewManager` calls it unconditionally for every entry rather
 * than needing to know which tiles are agent-owned.
 */
const releasedByWebContents = new WeakMap<
  AgentBrowserPostureWebContents,
  boolean
>();

/**
 * Background-work posture for the agent's own browser tile (ticket 02).
 *
 * The tile is created without stealing foreground - nothing here calls
 * `.focus()`, `.show()`, or otherwise activates the parent window. Instead,
 * every attached page is told (via CDP) that it is "active" so Chromium does
 * not throttle timers/rAF the way it would an ordinary background tab, and
 * that it has emulated focus so focus-dependent script behavior (e.g. text
 * selection, some event listeners) still works while a human is looking at a
 * different tile. This has to be re-applied after every main-frame
 * navigation: a cross-origin navigation can hand the page to a fresh
 * renderer process, which resets both properties.
 */
export function applyAgentBrowserBackgroundPosture(
  webContents: AgentBrowserPostureWebContents,
): void {
  // BT-402: a postured guest is agent-owned and eviction-exempt from the
  // moment posture applies, not only after some later release mark.
  releasedByWebContents.set(webContents, false);
  sendPostureCommands(webContents);
  webContents.on("did-navigate", () => {
    if (releasedByWebContents.get(webContents) === true) return;
    sendPostureCommands(webContents);
  });
}

export function setAgentBrowserPostureReleased(
  webContents: AgentBrowserPostureWebContents,
  released: boolean,
): void {
  releasedByWebContents.set(webContents, released);
}

/**
 * BT-402 exemption probe: TRUE while an agent owns this guest's background
 * posture (postured and not yet released). Guests that never went through
 * the posture path return false — they are ordinary user tiles and stay
 * evictable.
 */
export function isAgentBrowserPostureActive(
  webContents: AgentBrowserPostureWebContents,
): boolean {
  return releasedByWebContents.get(webContents) === false;
}

function sendPostureCommands(
  webContents: AgentBrowserPostureWebContents,
): void {
  if (webContents.isDestroyed()) return;
  const browserDebugger = webContents.debugger;
  try {
    if (!browserDebugger.isAttached()) {
      browserDebugger.attach("1.3");
    }
  } catch (err) {
    log.warn("[agent-browser-view] debugger attach failed", {
      error: describeLogError(err),
    });
    return;
  }

  Promise.all([
    browserDebugger.sendCommand(
      "Page.setWebLifecycleState",
      { state: "active" },
      undefined,
    ),
    browserDebugger.sendCommand(
      "Emulation.setFocusEmulationEnabled",
      { enabled: true },
      undefined,
    ),
  ]).catch((err: unknown) => {
    log.warn("[agent-browser-view] background posture command failed", {
      error: describeLogError(err),
    });
  });
}
