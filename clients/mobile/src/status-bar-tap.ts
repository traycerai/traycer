import type { IStatusBarTapHost } from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";

/** The window event the iOS bridge controller fires per status-bar tap. */
export const STATUS_TAP_EVENT = "statusTap";

/**
 * `IRunnerHost.statusBarTap` on iOS.
 *
 * The native half is `ios/App/App/BridgeViewController.swift`, which forwards
 * Capacitor's own tap notification as a window event. iOS-only by
 * construction: the entry point builds this on that platform alone, since no
 * other shell ever fires the event.
 */
export class MobileStatusBarTap implements IStatusBarTapHost {
  constructor(private readonly target: EventTarget) {}

  onTap(handler: () => void): Disposable {
    const listener = (): void => handler();
    this.target.addEventListener(STATUS_TAP_EVENT, listener);
    return {
      dispose: () => {
        this.target.removeEventListener(STATUS_TAP_EVENT, listener);
      },
    };
  }
}
