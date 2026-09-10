/**
 * The in-app sign-in sheet: the OS's own web-auth surface
 * (ASWebAuthenticationSession on iOS, a Chrome Custom Tab on Android), which
 * shares the system browser's cookies, password manager and passkeys - so the
 * approval page opens already signed in - and, on iOS, intercepts the
 * `<scheme>://auth/callback` return link itself, with no "Open in Traycer?"
 * prompt on the way back.
 *
 * SIGN-IN ONLY, by design. iOS shows a "wants to use <host> to sign in"
 * consent alert on every open (the price of the shared cookie jar), and the
 * general-purpose in-app browser (SFSafariViewController) has had an
 * app-isolated jar since iOS 11, so every other link keeps going to the
 * browser app - see `MobileRunnerHost.openExternalLink`.
 *
 * The device-flow contract is unchanged: the token still arrives only through
 * the `/device/token` poll, and the return signal stays payload-free. What
 * this adds is two more sources of that signal, because under the sheet the
 * app never backgrounds, so the foreground-resume edge has nothing to report:
 * the sheet's own completion (iOS), and the App plugin's `appUrlOpen` for the
 * return link (Android, where a half-height tab leaves the activity started).
 *
 * The native halves live in the app projects, not an npm package:
 * `ios/App/App/AuthSessionPlugin.swift` and
 * `android/app/src/main/java/com/traycer/app/AuthSessionPlugin.java`.
 */
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";

export interface AuthSessionOpenResult {
  /**
   * `callback`: the return link fired and the sheet dismissed itself (iOS).
   * `dismissed`: the sheet closed without it (iOS). `opened`: the tab is up
   * and the OS owns it from here (Android).
   */
  readonly outcome: "callback" | "dismissed" | "opened";
}

/** The native plugin's surface. Tests fake this boundary. */
export interface AuthSessionPluginSlice {
  /**
   * Presents `url`. On iOS the promise settles when the sheet CLOSES; on
   * Android as soon as the tab is launched. Rejects when the OS refused to
   * present anything.
   */
  open(options: {
    readonly url: string;
    readonly callbackScheme: string;
  }): Promise<AuthSessionOpenResult>;
  /** Dismisses the sheet if one is up; a no-op otherwise. */
  close(): Promise<void>;
}

export const AuthSession =
  registerPlugin<AuthSessionPluginSlice>("AuthSession");

/** The slice of `@capacitor/app` the return-link signal rides on. */
export interface AppUrlOpenSlice {
  addListener(
    eventName: "appUrlOpen",
    listener: (event: { readonly url: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export class MobileAuthSheet {
  private readonly returnHandlers = new Set<() => void>();
  private listeningForUrlOpen = false;
  /** Whether a sheet or tab this object opened may still be on screen. */
  private presented = false;

  constructor(
    private readonly plugin: AuthSessionPluginSlice,
    private readonly app: AppUrlOpenSlice,
    private readonly callbackScheme: string,
  ) {}

  /**
   * Opens the approval page in the sheet. `false` means the OS refused to
   * present it and the caller should fall back to the browser app; `true`
   * means it was presented - resolved, on iOS, only once it has closed again,
   * and a close by the return link fires the return signal.
   */
  async open(url: string): Promise<boolean> {
    this.presented = true;
    let result: AuthSessionOpenResult;
    try {
      result = await this.plugin.open({
        url,
        callbackScheme: this.callbackScheme,
      });
    } catch {
      this.presented = false;
      return false;
    }
    // Android resolves with the tab still up; iOS only once the sheet closed.
    if (result.outcome !== "opened") {
      this.presented = false;
    }
    if (result.outcome === "callback") {
      this.emitReturn();
    }
    return true;
  }

  /**
   * Dismisses the sheet, if one of ours may still be up. The guard matters on
   * Android, where `close` brings the activity forward: after the tab is
   * already gone that would yank Traycer over whatever the user moved on to.
   */
  close(): void {
    if (!this.presented) return;
    this.presented = false;
    void this.plugin.close().catch(() => {});
  }

  /** The payload-free return signal - see the module doc for its sources. */
  onReturn(handler: () => void): Disposable {
    this.ensureUrlOpenListener();
    this.returnHandlers.add(handler);
    return {
      dispose: () => {
        this.returnHandlers.delete(handler);
      },
    };
  }

  private ensureUrlOpenListener(): void {
    if (this.listeningForUrlOpen) return;
    this.listeningForUrlOpen = true;
    const returnUrl = `${this.callbackScheme}://auth/callback`;
    void this.app
      .addListener("appUrlOpen", (event) => {
        if (event.url.startsWith(returnUrl)) {
          // The link brought the activity forward, which finished the tab.
          this.presented = false;
          this.emitReturn();
        }
      })
      .catch((error: unknown) => {
        // The resume edge and the poll still complete the sign-in.
        console.warn("[mobile] appUrlOpen listener failed", error);
      });
  }

  private emitReturn(): void {
    for (const handler of Array.from(this.returnHandlers)) {
      try {
        handler();
      } catch (error) {
        // One bad subscriber must not cost the others their nudge - nor, on
        // iOS, reject `open()` after the sheet already completed, which would
        // read as "the OS refused" and reopen the page in the browser app.
        console.error("[mobile] auth-sheet return handler threw", error);
      }
    }
  }
}
