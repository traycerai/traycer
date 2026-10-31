import { Menu, Tray } from "electron";
import type {
  VoiceSessionIndicator,
  VoiceTrayAction,
} from "../../ipc-contracts/host-types";
import { log } from "../app/logger";
import type { VoiceAwayWindow } from "../windows/voice-live-windows";

/**
 * The voice item: while a window's voice session is live and the window is
 * away (blurred, or hidden by a close), a macOS menu-bar item or a Windows
 * notification-area item shows the session's state and offers Mute, End and
 * Return to Traycer (Tanveer, 2026-10-29). On Linux it is a
 * notification-area item where a StatusNotifier host shows one, and nothing
 * otherwise. It goes when the session ends, however it ends.
 *
 * One item per away window: the session lives in that window's renderer, so
 * every action names it. Separate from the app's own tray icon, which is
 * always there and carries none of this.
 */

/** What one shown item can be told after it is built. */
export interface VoiceTrayItemView {
  update(indicator: VoiceSessionIndicator): void;
  destroy(): void;
}

/** What an item's menu does, bound to its window. */
export interface VoiceTrayItemActions {
  setMuted(muted: boolean): void;
  end(): void;
  returnToTraycer(): void;
}

export interface VoiceTrayItemsDeps {
  /** The live windows that are away (`VoiceLiveWindows`). */
  readonly source: {
    away(): ReadonlyArray<VoiceAwayWindow>;
    subscribe(listener: () => void): () => void;
  };
  /**
   * Whether a tray the person can see exists right now. Asked when an item
   * is about to appear: a Linux panel extension can come or go mid-session.
   * A rejection reads as no tray.
   */
  readonly trayVisible: () => Promise<boolean>;
  readonly createView: (
    indicator: VoiceSessionIndicator,
    actions: VoiceTrayItemActions,
  ) => Promise<VoiceTrayItemView>;
  /** Sends the action to the renderer of `windowId`, which owns the session. */
  readonly sendAction: (windowId: string, action: VoiceTrayAction) => void;
  /** Shows and focuses `windowId`. */
  readonly returnTo: (windowId: string) => void;
}

/** Asking whether a tray exists, or building the item. */
interface PendingItem {
  readonly kind: "pending";
  /** The latest indicator, applied once the item is built. */
  indicator: VoiceSessionIndicator;
}

type ItemState =
  | PendingItem
  | { readonly kind: "shown"; readonly view: VoiceTrayItemView }
  /** No tray to show it in, or it could not be built: nothing until the session ends. */
  | { readonly kind: "none" };

export class VoiceTrayItems {
  private readonly deps: VoiceTrayItemsDeps;
  private readonly items = new Map<string, ItemState>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(deps: VoiceTrayItemsDeps) {
    this.deps = deps;
    this.unsubscribe = deps.source.subscribe(() => this.reconcile());
    this.reconcile();
  }

  /** Every item goes, and none comes again. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    for (const windowId of [...this.items.keys()]) this.remove(windowId);
  }

  private reconcile(): void {
    if (this.disposed) return;
    const away = this.deps.source.away();
    const wanted = new Set(away.map((window) => window.windowId));
    for (const windowId of [...this.items.keys()]) {
      if (!wanted.has(windowId)) this.remove(windowId);
    }
    for (const window of away) {
      const state = this.items.get(window.windowId);
      if (state === undefined) {
        this.add(window);
      } else if (state.kind === "pending") {
        state.indicator = window.indicator;
      } else if (state.kind === "shown") {
        state.view.update(window.indicator);
      }
    }
  }

  private add(window: VoiceAwayWindow): void {
    const { windowId } = window;
    const state: PendingItem = {
      kind: "pending",
      indicator: window.indicator,
    };
    this.items.set(windowId, state);
    void this.build(windowId, state);
  }

  private async build(windowId: string, state: PendingItem): Promise<void> {
    const current = (): boolean =>
      !this.disposed && this.items.get(windowId) === state;
    const visible = await this.deps.trayVisible().catch(() => false);
    if (!current()) return;
    if (!visible) {
      log.info("[voice-tray] no tray to show the voice item in");
      this.items.set(windowId, { kind: "none" });
      return;
    }
    let view: VoiceTrayItemView;
    try {
      view = await this.deps.createView(state.indicator, {
        setMuted: (muted) =>
          this.deps.sendAction(windowId, { kind: "setMuted", muted }),
        end: () => this.deps.sendAction(windowId, { kind: "end" }),
        returnToTraycer: () => this.deps.returnTo(windowId),
      });
    } catch (error) {
      log.warn("[voice-tray] voice item could not be built", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      if (current()) this.items.set(windowId, { kind: "none" });
      return;
    }
    // The session ended, or the shell is quitting, while the item was built.
    if (!current()) {
      view.destroy();
      return;
    }
    this.items.set(windowId, { kind: "shown", view });
    // The indicator may have moved while the item was built.
    view.update(state.indicator);
  }

  private remove(windowId: string): void {
    const state = this.items.get(windowId);
    this.items.delete(windowId);
    if (state?.kind === "shown") state.view.destroy();
  }
}

/** The one line the item says about the session. */
export function voiceTrayStateLabel(indicator: VoiceSessionIndicator): string {
  if (indicator.pausedForDictation) return "Paused for dictation";
  return indicator.muted ? "Muted" : "Listening";
}

/**
 * The item as Electron draws it: the app's tray glyph, the state as the
 * menu-bar title on macOS and as the tooltip everywhere, and a menu of the
 * state, Mute or Unmute, End, and Return to Traycer. A click on Windows and
 * Linux returns to Traycer; on macOS a click opens the menu.
 */
export function createElectronVoiceTrayView(input: {
  readonly image: Electron.NativeImage;
  readonly platform: NodeJS.Platform;
  readonly indicator: VoiceSessionIndicator;
  readonly actions: VoiceTrayItemActions;
}): VoiceTrayItemView {
  const { actions, platform } = input;
  const tray = new Tray(input.image);
  if (platform !== "darwin") {
    tray.on("click", () => actions.returnToTraycer());
  }
  const render = (indicator: VoiceSessionIndicator): void => {
    if (tray.isDestroyed()) return;
    const label = voiceTrayStateLabel(indicator);
    if (platform === "darwin") tray.setTitle(label);
    tray.setToolTip(`Traycer voice: ${label}`);
    // The value the click sets is captured with the label it is drawn
    // under: an open native menu can still fire after the state moved.
    const muteTo = !indicator.muted;
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label, enabled: false },
        { type: "separator" },
        {
          label: indicator.muted ? "Unmute" : "Mute",
          click: () => actions.setMuted(muteTo),
        },
        { label: "End", click: () => actions.end() },
        { type: "separator" },
        {
          label: "Return to Traycer",
          click: () => actions.returnToTraycer(),
        },
      ]),
    );
  };
  render(input.indicator);
  return {
    update: render,
    destroy: () => {
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}
