/**
 * Link-login codes the OS hands this app as a URL, so a QR scanned by the
 * SYSTEM camera signs in the same way the in-app scanner does.
 *
 * Two delivery paths, and both are required — this is the whole reason the
 * module exists rather than a single listener living in the entry point:
 *
 * - WARM: the app is already running, the OS raises `appUrlOpen`.
 * - COLD: the scan LAUNCHED the app. The listener cannot exist yet when the
 *   URL is delivered, so `appUrlOpen` never fires for it and the only place
 *   the URL can be read is `App.getLaunchUrl()` at bootstrap.
 *
 * Whatever arrives is parsed by the shared `parseLinkLoginInput`, never by
 * hand: it already owns every accepted payload shape, and it is what makes a
 * non-payload URL fall out silently. That silence is deliberate — this flow is
 * started by the operating system, not by a user who asked for a scan, so
 * there is no surface that a "that wasn't a code" complaint belongs to. The
 * `traycer://auth/callback` return link the device-approval page fires lands
 * here on every browser sign-in and must cost nothing.
 *
 * Codes are BUFFERED until a subscriber exists and replayed on subscribe, the
 * same shape (and for the same cold-start reason) as the tapped-push relay in
 * `push-registration.ts`. Here it also covers the gap after the GUI is
 * running: the sign-in surface only mounts once the host runtime is up, and
 * the code has to survive that.
 */
import type { PluginListenerHandle } from "@capacitor/core";
import { parseLinkLoginInput } from "@traycer-clients/shared/auth/link-login";
import type { ILinkLoginDeepLinkSource } from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";

/**
 * The slice of `@capacitor/app` this module drives. Tests fake this boundary;
 * `main.tsx` passes the real plugin, which satisfies it structurally.
 */
export interface AppPluginSlice {
  /** `undefined` — the plugin's own spelling — when nothing launched the app. */
  getLaunchUrl(): Promise<{ readonly url: string } | undefined>;
  addListener(
    eventName: "appUrlOpen",
    listener: (event: { readonly url: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export class MobileLinkLoginDeepLinks implements ILinkLoginDeepLinkSource {
  private started = false;
  private handler: ((code: string) => void) | null = null;
  private pendingCode: string | null = null;
  /**
   * The last code taken off a URL, kept for the lifetime of the launch rather
   * than only while one is pending.
   *
   * A cold start can deliver the SAME url twice: `getLaunchUrl()` resolves it,
   * and iOS may also raise `appUrlOpen` for the launch that is already under
   * way. Two claims on one code is not a duplicate no-op — first claim wins
   * and the second gets a 401, which would surface to the user as "that code
   * is invalid" on a sign-in that was working.
   */
  private lastCode: string | null = null;

  constructor(private readonly plugin: AppPluginSlice) {}

  /**
   * Attaches the warm listener and reads the cold launch URL. Called once from
   * bootstrap, BEFORE the GUI renders, so a launching scan is captured no
   * matter how long the app takes to become interactive.
   *
   * Neither path is allowed to fail the boot: a plugin that rejects costs this
   * one sign-in shortcut, and the scan-in-app and typed-code paths are both
   * untouched.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.plugin
      .addListener("appUrlOpen", (event) => {
        this.offer(event.url);
      })
      .catch((error: unknown) => {
        console.warn("[mobile] appUrlOpen listener failed", error);
      });
    void this.plugin
      .getLaunchUrl()
      .then((launch) => {
        if (launch !== undefined) {
          this.offer(launch.url);
        }
      })
      .catch((error: unknown) => {
        console.warn("[mobile] launch URL read failed", error);
      });
  }

  onLinkLoginCode(handler: (code: string) => void): Disposable {
    this.handler = handler;
    const pending = this.pendingCode;
    if (pending !== null) {
      this.pendingCode = null;
      handler(pending);
    }
    return {
      dispose: () => {
        if (this.handler === handler) {
          this.handler = null;
        }
      },
    };
  }

  private offer(url: string): void {
    const code = parseLinkLoginInput(url);
    if (code === null || code === this.lastCode) {
      return;
    }
    this.lastCode = code;
    if (this.handler !== null) {
      this.handler(code);
      return;
    }
    // Only the newest survives. An older code is already dead or about to be:
    // the server keeps one live unclaimed code per account, so a second scan
    // superseded the first anyway.
    this.pendingCode = code;
  }
}
