import type { PluginListenerHandle } from "@capacitor/core";
import type { ISystemBackHost } from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";

/** The App plugin's `backButton` payload; the WebView's own page history. */
export interface BackButtonEvent {
  readonly canGoBack: boolean;
}

/**
 * The slice of `@capacitor/app` this adapter uses, so tests fake the plugin
 * at the package boundary and the plugin import stays in the entry point.
 */
export interface SystemBackPluginSlice {
  addListener(
    eventName: "backButton",
    listener: (event: BackButtonEvent) => void,
  ): Promise<PluginListenerHandle>;
  minimizeApp(): Promise<void>;
}

/**
 * `IRunnerHost.systemBack` on Android.
 *
 * Registering ANY `backButton` listener is what takes the press away from the
 * plugin's default handling, which on this app is nothing at all: the GUI
 * keeps its history in its own in-memory stack, so the WebView's page history
 * the default consults is always a single entry. `canGoBack` on the event
 * describes that same page history and is deliberately not forwarded - the
 * GUI answers "is there anything behind" from its own stack.
 *
 * Android-only by construction: the entry point builds this on that platform
 * alone. iOS raises no such event and `minimizeApp` is unimplemented there.
 */
export class MobileSystemBack implements ISystemBackHost {
  constructor(private readonly plugin: SystemBackPluginSlice) {}

  onBack(handler: () => void): Disposable {
    let disposed = false;
    let handle: PluginListenerHandle | null = null;
    void this.plugin
      .addListener("backButton", () => {
        // The attach is asynchronous, so a listener can be live for a press
        // that lands after its subscription was disposed but before the
        // removal below caught up.
        if (!disposed) handler();
      })
      .then((attached) => {
        if (disposed) {
          void attached.remove();
          return;
        }
        handle = attached;
      })
      .catch((error: unknown) => {
        console.warn("[system-back] attach failed", error);
      });
    return {
      dispose: () => {
        disposed = true;
        void handle?.remove();
        handle = null;
      },
    };
  }

  minimize(): Promise<void> {
    return this.plugin.minimizeApp();
  }
}
