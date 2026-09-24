import type { HostLifecycleMode } from "@traycer/protocol/config/host-lifecycle-policy";
import { log } from "../app/logger";
import type { JsonFileStore } from "../app/json-file-store";
import type { RegistryManagedWindow, WindowRegistry } from "./window-registry";

// Close-to-tray on Windows and Linux (host-lifecycle-modes D5, T06). Under a
// mode whose quit does something to the host - Linked stops it, Ask and
// Stop-if-idle may - closing the last window must not be the quit: the user
// closed a window, and only Quit (tray, menu, Ctrl+Q) runs the quit policy.
// So the LAST window's `close` is intercepted, not `window-all-closed`: by
// then the window is gone, the registry has dropped it, and the tray's Show
// has nothing to restore (critique R10).
//
// The policy is read fresh (the CLI co-writes it), which is asynchronous,
// while `close` must be prevented synchronously. So a candidate close is
// always prevented first and then settled:
//
//   linked / ask / stop-if-idle, tray      hide; the window stays registered
//                                          for the tray's Show; a one-time
//                                          notice says where the app went.
//   linked / ask / stop-if-idle, no tray   quit WITH the window alive, so the
//                                          quit modal and the stopping state
//                                          render in it and Cancel leaves it
//                                          open. Letting it close first would
//                                          leave no window for the modal and,
//                                          with no tray either, a native
//                                          Cancel would strand a windowless
//                                          process.
//   background / none                      unchanged: the close is re-issued
//                                          and goes through as before - unless
//                                          hidden windows remain from an
//                                          earlier close-to-tray, which would
//                                          keep an invisible app alive; then
//                                          it is the quit, as
//                                          `window-all-closed` would have been.
//
// macOS is untouched: a closed window never quits the app there.

/** The modes whose quit policy acts on the host (D5). */
const CLOSE_TO_TRAY_MODES: ReadonlySet<HostLifecycleMode> = new Set([
  "linked",
  "ask",
  "stop-if-idle",
]);

export type LastWindowCloseAction =
  | "hide-to-tray"
  | "quit-with-window"
  | "close";

/** What closing the last visible window does, once the mode is known. */
export function lastWindowCloseAction(input: {
  readonly mode: HostLifecycleMode;
  readonly hasTray: boolean;
  readonly otherHiddenWindowCount: number;
}): LastWindowCloseAction {
  if (CLOSE_TO_TRAY_MODES.has(input.mode)) {
    return input.hasTray ? "hide-to-tray" : "quit-with-window";
  }
  return input.otherHiddenWindowCount > 0 ? "quit-with-window" : "close";
}

/** The window operations the intercept needs, by registry id. */
export interface CloseToTrayWindows {
  /** Whether the window is still registered and not destroyed. */
  isLive(windowId: string): boolean;
  /** Other live windows the user can still reach (visible or minimized). */
  otherOpenWindowCount(windowId: string): number;
  /** Other live windows that are hidden (an earlier close-to-tray). */
  otherHiddenWindowCount(windowId: string): number;
  hide(windowId: string): void;
  /** Close it again; the intercept lets that one close through. */
  close(windowId: string): void;
}

/** A registry window the intercept can classify and hide. */
export interface CloseToTrayManagedWindow extends RegistryManagedWindow {
  hide(): void;
  isMinimized(): boolean;
}

/**
 * The registry's windows as the intercept sees them. A minimized window is
 * still open (the taskbar restores it); a hidden one is not - it is an
 * earlier close-to-tray.
 */
export function registryCloseToTrayWindows<
  TWindow extends CloseToTrayManagedWindow,
>(
  registry: Pick<
    WindowRegistry<TWindow>,
    "records" | "getWindowById" | "closeById"
  >,
): CloseToTrayWindows {
  const others = (windowId: string): TWindow[] =>
    registry
      .records()
      .filter(
        (record) =>
          record.windowId !== windowId && !record.window.isDestroyed(),
      )
      .map((record) => record.window);
  const reachable = (window: TWindow): boolean =>
    window.isVisible() || window.isMinimized();
  return {
    isLive: (windowId) => {
      const window = registry.getWindowById(windowId);
      return window !== null && !window.isDestroyed();
    },
    otherOpenWindowCount: (windowId) =>
      others(windowId).filter(reachable).length,
    otherHiddenWindowCount: (windowId) =>
      others(windowId).filter((window) => !reachable(window)).length,
    hide: (windowId) => {
      registry.getWindowById(windowId)?.hide();
    },
    close: (windowId) => {
      void registry.closeById(windowId);
    },
  };
}

export interface CloseToTrayDeps {
  readonly platform: NodeJS.Platform;
  readonly hasTray: () => boolean;
  readonly isQuitting: () => boolean;
  /** `HostLifecycleService.readQuitPolicy` - `none` once the lanes are off. */
  readonly readQuitMode: () => Promise<HostLifecycleMode>;
  readonly windows: CloseToTrayWindows;
  readonly requestQuit: () => void;
  readonly showNoticeOnce: () => void;
}

export class CloseToTray {
  private readonly deps: CloseToTrayDeps;
  /** Windows whose next `close` is the re-issued one and goes through. */
  private readonly approved = new Set<string>();
  /** Windows whose close is waiting on the policy read. */
  private readonly pending = new Set<string>();

  constructor(deps: CloseToTrayDeps) {
    this.deps = deps;
  }

  /**
   * Called first from every window's `close` listener. `true` when the
   * intercept took the event (it has prevented it); `false` leaves the event
   * to the existing close handling.
   */
  interceptClose(windowId: string, event: { preventDefault(): void }): boolean {
    if (this.deps.platform === "darwin") return false;
    if (this.approved.delete(windowId)) return false;
    if (this.deps.isQuitting()) return false;
    if (this.deps.windows.otherOpenWindowCount(windowId) > 0) return false;
    event.preventDefault();
    if (this.pending.has(windowId)) return true;
    this.pending.add(windowId);
    void this.settle(windowId);
    return true;
  }

  private async settle(windowId: string): Promise<void> {
    let mode: HostLifecycleMode;
    try {
      mode = await this.deps.readQuitMode();
    } catch {
      // An unreadable policy is Background by contract.
      mode = "background";
    }
    this.pending.delete(windowId);
    // A quit that began meanwhile closes the window itself.
    if (!this.deps.windows.isLive(windowId) || this.deps.isQuitting()) return;
    const action = lastWindowCloseAction({
      mode,
      hasTray: this.deps.hasTray(),
      otherHiddenWindowCount:
        this.deps.windows.otherHiddenWindowCount(windowId),
    });
    log.info("[close-to-tray] last window closed", { mode, reason: action });
    switch (action) {
      case "hide-to-tray":
        this.deps.windows.hide(windowId);
        this.deps.showNoticeOnce();
        return;
      case "quit-with-window":
        this.deps.requestQuit();
        return;
      case "close":
        this.approved.add(windowId);
        this.deps.windows.close(windowId);
        return;
    }
  }
}

export const CLOSE_TO_TRAY_NOTICE_FILE_NAME = "close-to-tray-notice.json";

export interface CloseToTrayNoticeState {
  readonly shown: boolean;
}

export function parseCloseToTrayNoticeState(
  value: unknown,
): CloseToTrayNoticeState {
  return {
    shown:
      value !== null &&
      typeof value === "object" &&
      Reflect.get(value, "shown") === true,
  };
}

/**
 * The one-time "still running in the tray" notice: at most once per process,
 * and never again once the store says it was shown. The store lives in
 * `userData`, which `main-process.ts` already scopes per app identity - the
 * environment's stamped app name, plus `<appName>-<slot>` for a dev slot - so
 * a dev slot and production never share the flag.
 */
export function createCloseToTrayNoticeOnce(options: {
  readonly store: JsonFileStore<CloseToTrayNoticeState>;
  readonly show: () => void;
}): () => void {
  let requested = false;
  return () => {
    if (requested) return;
    requested = true;
    void options.store
      .load()
      .then(async (state) => {
        if (state.shown) return;
        options.show();
        await options.store.save({ shown: true });
      })
      .catch((error: unknown) => {
        log.warn("[close-to-tray] notice failed", {
          reason: "notice-failed",
          errorName: error instanceof Error ? error.name : typeof error,
        });
      });
  };
}
