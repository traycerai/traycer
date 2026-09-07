/**
 * Link-login codes the OS hands this app as a URL, so a QR scanned by the system camera signs in the same way the in-app scanner does.
 * Two delivery paths, and both are required - this is the whole reason the module exists rather than a single listener living in the entry point: - warm: the app is already running, the OS raises `appUrlOpen`.
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
  /** `undefined` - the plugin's own spelling - when nothing launched the app. */
  getLaunchUrl(): Promise<{ readonly url: string } | undefined>;
  addListener(
    eventName: "appUrlOpen",
    listener: (event: { readonly url: string }) => void,
  ): Promise<PluginListenerHandle>;
}

/**
 * How close together two deliveries of one code have to be to read as the OS double-announcing a single arrival.
 * Generous next to the milliseconds that actually separate the cold-launch pair, and far short of the ~60s a code lives, so it cannot eat a deliberate rescan.
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
   * Attaches the warm listener and reads the cold launch URL.
   * Called once from bootstrap, before the gui renders, so a launching scan is captured no matter how long the app takes to become interactive.
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
   * Whether this is the OS announcing one arrival twice rather than the user scanning twice.
   * Two claims on one code is not a harmless repeat - first claim wins and the second gets a 401, which reads to the user as "that code is invalid" on a sign-in that was working.
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
    // Only the newest survives.
    // An older code is already dead or about to be: the server keeps one live unclaimed code per account, so a second scan superseded the first anyway.
    this.pending = delivery;
  }
}
