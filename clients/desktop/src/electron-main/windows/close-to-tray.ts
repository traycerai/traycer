import type { HostLifecycleMode } from "@traycer/protocol/config/host-lifecycle-policy";
import { log } from "../app/logger";
import type { JsonFileStore } from "../app/json-file-store";
import type {
  RegistryManagedWindow,
  WindowRegistry,
  WindowRegistryRecord,
} from "./window-registry";

// Close-to-tray on Windows and Linux. Under a
// mode whose quit does something to the host - Linked stops it, Ask and
// Stop-if-idle may - closing the last window must not be the quit: the user
// closed a window, and only Quit (tray, menu, Ctrl+Q) runs the quit policy.
// So the LAST window's `close` is intercepted, not `window-all-closed`: by
// then the window is gone, the registry has dropped it, and the tray's Show
// has nothing to restore.
//
// The policy is read fresh (the CLI co-writes it), which is asynchronous,
// while `close` must be prevented synchronously. So a candidate close is
// always prevented first and then settled:
//
//   linked / ask / stop-if-idle, tray      hide; the window stays registered
//                                          for the tray's Show; a one-time
//                                          notice says where the app went.
//                                          "Tray" is one that can be SEEN,
//                                          asked at close time: on Linux a
//                                          constructed `Tray` is not enough
//                                          (see `tray/linux-tray-host.ts`).
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
// "Hidden" is only a window this intercept hid (`HiddenToTrayWindows`), never
// one inferred from visibility: a window still loading is created
// `show: false` until `ready-to-show`, and it keeps the app alive as it did
// before close-to-tray existed - the close of the last visible window beside
// it is not intercepted at all.
//
// macOS is untouched: a closed window never quits the app there.

/** The modes whose quit policy acts on the host. */
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
  /**
   * Other live windows that keep the app open: every one this intercept has
   * not hidden - visible, minimized, or still loading.
   */
  otherOpenWindowCount(windowId: string): number;
  /** Other live windows this intercept hid (an earlier close-to-tray). */
  otherHiddenWindowCount(windowId: string): number;
  /** Hide it to the tray, and remember that it was. */
  hide(windowId: string): void;
  /** Close it again; the intercept lets that one close through. */
  close(windowId: string): void;
}

/** A registry window the intercept can classify and hide. */
export interface CloseToTrayManagedWindow extends RegistryManagedWindow {
  hide(): void;
  isMinimized(): boolean;
}

/** The window state that tells whether a window hidden to the tray still is. */
export interface HiddenToTrayCandidate {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
}

/**
 * The windows the close-to-tray intercept itself hid, by registry id - the
 * only windows that count as hidden. One per process, shared by the intercept
 * and the quit's stopping reveal.
 */
export class HiddenToTrayWindows {
  private readonly ids = new Set<string>();

  add(windowId: string): void {
    this.ids.add(windowId);
  }

  /**
   * Whether `window` (registered as `windowId`, or `null` when it is not) is
   * still hidden to the tray: this intercept hid it, and it has been neither
   * shown again (the tray's Show, a quit prompt) nor destroyed since. An
   * entry that no longer holds is dropped.
   */
  holds(windowId: string, window: HiddenToTrayCandidate | null): boolean {
    if (!this.ids.has(windowId)) return false;
    if (
      window === null ||
      window.isDestroyed() ||
      window.isVisible() ||
      window.isMinimized()
    ) {
      this.ids.delete(windowId);
      return false;
    }
    return true;
  }
}

/**
 * The registry's windows as the intercept sees them: a window is hidden only
 * if `hiddenToTray` holds it, and every other live one - visible, minimized
 * (the taskbar restores it), or still loading - is open.
 */
export function registryCloseToTrayWindows<
  TWindow extends CloseToTrayManagedWindow,
>(
  registry: Pick<
    WindowRegistry<TWindow>,
    "records" | "getWindowById" | "closeById"
  >,
  hiddenToTray: HiddenToTrayWindows,
): CloseToTrayWindows {
  const others = (windowId: string): WindowRegistryRecord<TWindow>[] =>
    registry
      .records()
      .filter(
        (record) =>
          record.windowId !== windowId && !record.window.isDestroyed(),
      );
  const hidden = (record: WindowRegistryRecord<TWindow>): boolean =>
    hiddenToTray.holds(record.windowId, record.window);
  return {
    isLive: (windowId) => {
      const window = registry.getWindowById(windowId);
      return window !== null && !window.isDestroyed();
    },
    otherOpenWindowCount: (windowId) =>
      others(windowId).filter((record) => !hidden(record)).length,
    otherHiddenWindowCount: (windowId) =>
      others(windowId).filter(hidden).length,
    hide: (windowId) => {
      const window = registry.getWindowById(windowId);
      if (window === null) return;
      window.hide();
      hiddenToTray.add(windowId);
    },
    close: (windowId) => {
      void registry.closeById(windowId);
    },
  };
}

export interface CloseToTrayDeps {
  readonly platform: NodeJS.Platform;
  /**
   * Whether a tray the user can see exists right now. Asked at close time,
   * not at boot: a Linux panel extension can come or go mid-session. A
   * rejection reads as no tray.
   */
  readonly hasTray: () => Promise<boolean>;
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
    // Only a mode that would hide to the tray needs the answer, and it is
    // read before the checks below so a quit that begins while it runs still
    // wins.
    const hasTray = CLOSE_TO_TRAY_MODES.has(mode)
      ? await this.deps.hasTray().catch(() => false)
      : false;
    this.pending.delete(windowId);
    // A quit that began meanwhile closes the window itself.
    if (!this.deps.windows.isLive(windowId) || this.deps.isQuitting()) return;
    const action = lastWindowCloseAction({
      mode,
      hasTray,
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
 * The one-time "still running in the tray" notice: shown until the platform
 * CONFIRMS it was displayed, then never again. `show` resolves `true` only on
 * that confirmation (a Linux notification's `show`, a Windows balloon's
 * `balloon-show`); anything else - no notification daemon, a failure, no
 * confirmation within its bound - leaves the flag unset, so the next
 * close-to-tray tries again. At most one attempt is in flight per process.
 *
 * The store lives in `userData`, which `main-process.ts` already scopes per
 * app identity - the environment's stamped app name, plus `<appName>-<slot>`
 * for a dev slot - so a dev slot and production never share the flag.
 */
export function createCloseToTrayNoticeOnce(options: {
  readonly store: JsonFileStore<CloseToTrayNoticeState>;
  readonly show: () => Promise<boolean>;
}): () => void {
  let settled = false;
  let inFlight = false;
  return () => {
    if (settled || inFlight) return;
    inFlight = true;
    void options.store
      .load()
      .then(async (state) => {
        if (state.shown) {
          settled = true;
          return;
        }
        if (!(await options.show())) {
          log.info("[close-to-tray] notice not shown", {
            reason: "not-confirmed",
          });
          return;
        }
        await options.store.save({ shown: true });
        settled = true;
      })
      .catch((error: unknown) => {
        log.warn("[close-to-tray] notice failed", {
          reason: "notice-failed",
          errorName: error instanceof Error ? error.name : typeof error,
        });
      })
      .finally(() => {
        inFlight = false;
      });
  };
}
