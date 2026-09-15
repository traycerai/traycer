import type { BrowserViewColorSchemePreference } from "@traycer-clients/shared/platform/browser-view";
import { describeLogError, log } from "../../app/logger";

/**
 * The CDP surface this module drives. Narrow on purpose: emulation is a
 * fire-and-forget projection onto a guest, so it needs to send commands and
 * nothing else - no event stream, no frame routing, no session identity. Taking
 * the function rather than the session keeps the suites free of a debugger.
 */
export type BrowserEmulationSend = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/**
 * What a tile has asked its page to pretend about itself.
 *
 * Held as state rather than applied and forgotten because every override here
 * is scoped to the RENDERER, and a cross-document navigation gets a new one.
 * Chromium keeps device metrics across a same-process navigation and drops them
 * across a process swap, which is the worst of both: an override that usually
 * survives cannot be treated as either durable or absent. {@link reapply} is
 * what makes it deterministic - the tile restates its intent on every commit,
 * so a page reached by clicking a cross-origin link is emulated exactly like
 * one reached by typing its address.
 */
export interface BrowserEmulationState {
  readonly colorScheme: BrowserViewColorSchemePreference;
  /**
   * The device character a tile asks for WITHOUT taking over its geometry.
   *
   * A browser tile is a renderer-owned `<webview>`, so its CSS box is already
   * the page's viewport: resizing the element is a real reflow at a real width,
   * and it is what the viewport rows in the toolbar do. What the CSS box cannot
   * say is what KIND of device that width belongs to - a page at 390px with a
   * fine pointer and a ratio of 2 still takes its desktop branch, so a media
   * query on `pointer: coarse` and a `devicePixelRatio` read both answer wrong.
   *
   * This carries only those two, and deliberately leaves width and height to
   * the element. Sending geometry here as well would put two authorities on the
   * same number: the page would lay out at the override's height inside a
   * shorter box and be clipped, which is the failure a geometry-free profile
   * makes structurally impossible.
   */
  readonly deviceProfile: BrowserEmulationDeviceProfile | null;
}

/** The geometry-free half of a device profile. */
export interface BrowserEmulationDeviceProfile {
  readonly devicePixelRatio: number;
  readonly mobile: boolean;
  readonly touch: boolean;
}

const DEFAULT_BROWSER_EMULATION_STATE: BrowserEmulationState = {
  colorScheme: "system",
  deviceProfile: null,
};

/**
 * Applies one tile's emulation intent to its guest.
 *
 * Every method is total and never throws: emulation is an accessory to
 * whatever the user was actually doing (resizing a tile, picking a menu row),
 * and a rejected CDP command - a guest that navigated mid-flight, a debugger
 * that detached - must not fail that gesture. Failures are logged with the
 * command that produced them and the tile keeps its intent, so the next
 * `reapply` retries it for free.
 */
export class BrowserPageEmulation {
  private readonly send: BrowserEmulationSend;
  private state: BrowserEmulationState = DEFAULT_BROWSER_EMULATION_STATE;

  constructor(send: BrowserEmulationSend) {
    this.send = send;
  }

  snapshot(): BrowserEmulationState {
    return this.state;
  }

  async setColorScheme(
    colorScheme: BrowserViewColorSchemePreference,
  ): Promise<void> {
    this.state = { ...this.state, colorScheme };
    await this.applyColorScheme();
  }

  /**
   * Adopts a device character for a tile whose geometry stays with its element.
   * `null` returns the page to this machine's own ratio and pointer.
   */
  async setDeviceProfile(
    deviceProfile: BrowserEmulationDeviceProfile | null,
  ): Promise<void> {
    this.state = { ...this.state, deviceProfile };
    await this.applyDeviceProfile();
  }

  /**
   * Restates the whole intent, for a navigation commit.
   *
   * Ordered sizing-then-scheme so a page that reads its viewport during first
   * paint sees the emulated one; the scheme is a media query the page re-reads
   * on its own when it changes, so it can follow.
   */
  async reapply(): Promise<void> {
    await this.applyDeviceProfile();
    await this.applyColorScheme();
  }

  /**
   * Drops the cached responses this guest can see.
   *
   * `Network.clearBrowserCache` rather than a session-level clear: the session
   * ports in `storage/` are the cookie jar's, where every removal is priced
   * against the forget ledger and a whole-jar barrier because it is a login.
   * A cache entry is a copy of a public response and must not travel that
   * path - see the `clearCache` action's own note.
   */
  async clearCache(): Promise<boolean> {
    return await this.attempt("Network.clearBrowserCache", {});
  }

  private async applyDeviceProfile(): Promise<void> {
    const profile = this.state.deviceProfile;
    if (profile === null) {
      await this.attempt("Emulation.clearDeviceMetricsOverride", {});
      await this.applyTouch(false);
      return;
    }
    // Zero edges are how CDP spells "do not override this dimension", which is
    // what keeps the element the only authority on geometry.
    const applied = await this.attempt("Emulation.setDeviceMetricsOverride", {
      width: 0,
      height: 0,
      deviceScaleFactor: profile.devicePixelRatio,
      mobile: profile.mobile,
    });
    if (!applied) return;
    await this.applyTouch(profile.touch);
  }

  /**
   * Touch is two commands, not one: the first decides whether the page sees a
   * touch-capable device (`navigator.maxTouchPoints`, the `pointer: coarse`
   * media query), the second decides whether the mouse the user actually has
   * generates touch events. Sending only the first produces a page that styles
   * itself for touch and then never receives a tap.
   */
  private async applyTouch(enabled: boolean): Promise<void> {
    await this.attempt("Emulation.setTouchEmulationEnabled", {
      enabled,
      maxTouchPoints: enabled ? 5 : 1,
    });
    await this.attempt("Emulation.setEmitTouchEventsForMouse", {
      enabled,
      configuration: enabled ? "mobile" : "desktop",
    });
  }

  private async applyColorScheme(): Promise<void> {
    // An empty feature list is how CDP spells "stop overriding", which is what
    // `system` has to mean: the page goes back to reading the OS, live.
    const features =
      this.state.colorScheme === "system"
        ? []
        : [{ name: "prefers-color-scheme", value: this.state.colorScheme }];
    await this.attempt("Emulation.setEmulatedMedia", { features });
  }

  private async attempt(
    method: string,
    params: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      await this.send(method, params);
      return true;
    } catch (error) {
      log.debug("[browser-view] emulation command failed", {
        method,
        err: describeLogError(error),
      });
      return false;
    }
  }
}
