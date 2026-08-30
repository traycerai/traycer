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
import type {
  ILinkLoginDeepLinkSource,
  LinkLoginDeepLinkDelivery,
} from "@traycer-clients/shared/platform/runner-host";
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

/**
 * How close together two deliveries of one code have to be to read as the OS
 * double-announcing a single arrival. Generous next to the milliseconds that
 * actually separate the cold-launch pair, and far short of the ~60s a code
 * lives, so it cannot eat a deliberate rescan.
 */
const DUPLICATE_DELIVERY_WINDOW_MS = 5_000;

export class MobileLinkLoginDeepLinks implements ILinkLoginDeepLinkSource {
  private started = false;
  private handler: ((delivery: LinkLoginDeepLinkDelivery) => void) | null =
    null;
  private pending: LinkLoginDeepLinkDelivery | null = null;
  /** Identity for each accepted arrival; see `LinkLoginDeepLinkDelivery`. */
  private nextDeliveryId = 1;
  /** The last code taken off a URL, with when it arrived. */
  private lastDelivery: {
    readonly code: string;
    readonly atMs: number;
  } | null = null;

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

  onLinkLoginCode(
    handler: (delivery: LinkLoginDeepLinkDelivery) => void,
  ): Disposable {
    this.handler = handler;
    const pending = this.pending;
    if (pending !== null) {
      this.pending = null;
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

  /**
   * Whether this is the OS announcing one arrival twice rather than the user
   * scanning twice.
   *
   * A cold start can deliver the same URL through both paths: `getLaunchUrl()`
   * resolves it, and iOS may also raise `appUrlOpen` for the launch already
   * under way. Two claims on one code is not a harmless repeat — first claim
   * wins and the second gets a 401, which reads to the user as "that code is
   * invalid" on a sign-in that was working.
   *
   * Bounded by a WINDOW, not by the process lifetime. The pair arrives within
   * milliseconds of each other, whereas a genuine rescan of the same still-live
   * QR is a deliberate second act by a person — scanning while signed in,
   * getting the "already signed in" notice, signing out and scanning again is
   * the case that a lifetime memory would silently swallow, leaving the app
   * looking like it ignored them.
   */
  private isBurstDuplicate(code: string): boolean {
    const previous = this.lastDelivery;
    if (previous === null || previous.code !== code) {
      return false;
    }
    return Date.now() - previous.atMs < DUPLICATE_DELIVERY_WINDOW_MS;
  }

  private offer(url: string): void {
    const code = parseLinkLoginInput(url);
    if (code === null || this.isBurstDuplicate(code)) {
      return;
    }
    this.lastDelivery = { code, atMs: Date.now() };
    const delivery: LinkLoginDeepLinkDelivery = {
      code,
      deliveryId: this.nextDeliveryId,
    };
    this.nextDeliveryId += 1;
    if (this.handler !== null) {
      this.handler(delivery);
      return;
    }
    // Only the newest survives. An older code is already dead or about to be:
    // the server keeps one live unclaimed code per account, so a second scan
    // superseded the first anyway.
    this.pending = delivery;
  }
}
