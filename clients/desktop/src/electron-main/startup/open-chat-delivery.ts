import type { OpenChatDeepLinkTarget } from "../auth/deep-link";

/** The window an open-chat link would be handed to, as far as delivery cares. */
export interface OpenChatWindow {
  readonly windowId: string;
  /** The renderer has finished loading its page (not loading, URL set). */
  readonly loaded: boolean;
  /** Calls `listener` once, on this window's next `did-finish-load`. */
  onceLoaded(listener: () => void): void;
}

export interface OpenChatDeliveryPorts {
  /** The window a link goes to (the MRU live window), or null when none is open. */
  readonly targetWindow: () => OpenChatWindow | null;
  /** Opens a window when none is live (restored snapshot or a blank window). */
  readonly openWindow: () => void;
  readonly deliver: (target: OpenChatDeepLinkTarget) => void;
}

/**
 * The one path every `traycer://open/epic/<id>/chat/<id>` link takes to a
 * renderer. It holds a single pending target - a newer link replaces an older
 * one that has not been delivered - and hands it over once, to a window whose
 * renderer has finished loading. Until the ports are attached (cold start, the
 * bridge does not exist yet) links only accumulate. With no live window (macOS
 * keeps the app running after the last one closes) it opens one and delivers
 * when that window has loaded.
 */
export class OpenChatDelivery {
  private pending: OpenChatDeepLinkTarget | null = null;
  private ports: OpenChatDeliveryPorts | null = null;
  private waitingOnWindowId: string | null = null;
  private windowRequested = false;

  offer(target: OpenChatDeepLinkTarget): void {
    this.pending = target;
    this.flush();
  }

  attach(ports: OpenChatDeliveryPorts): void {
    this.ports = ports;
    this.flush();
  }

  /** Re-checks delivery; call when the set of windows changes. */
  flush(): void {
    const ports = this.ports;
    const target = this.pending;
    if (ports === null || target === null) {
      return;
    }
    const window = ports.targetWindow();
    if (window === null) {
      if (!this.windowRequested) {
        this.windowRequested = true;
        ports.openWindow();
      }
      return;
    }
    this.windowRequested = false;
    if (!window.loaded) {
      if (this.waitingOnWindowId !== window.windowId) {
        this.waitingOnWindowId = window.windowId;
        window.onceLoaded(() => {
          this.waitingOnWindowId = null;
          this.flush();
        });
      }
      return;
    }
    this.pending = null;
    ports.deliver(target);
  }
}
