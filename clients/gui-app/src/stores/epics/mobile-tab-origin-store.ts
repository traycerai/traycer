import { create } from "zustand";
import { isPhoneLayoutOnly } from "@/lib/mobile-app";
import type { TracyTranscriptOrigin } from "@/lib/tab-navigation/intents";
import type { TabRef } from "@/stores/tabs/types";

/** The task tab a Tracy transcript link opened, and the channel it came from. */
interface MobileTabOrigin {
  readonly tabId: string;
  readonly botId: string;
}

/**
 * The pane header's way back to Tracy (leaving a task opened from a Tracy
 * transcript returns to that channel, not to Home, whichever channel the
 * surface has moved to since). It belongs to the one visit the link started:
 * any other opening of the task, and the task leaving the front by any route,
 * spends it, so coming back to the task later shows no way back. Session-only.
 *
 * Installed app only, where the pane header draws it.
 */
interface MobileTabOriginState {
  readonly origin: MobileTabOrigin | null;
  /**
   * How many times the surface has closed, and how many times each bot has
   * gone: an opening still in flight across either for its bot lands no way
   * back, even once the surface or the bot is back. Another bot going leaves
   * it alone.
   */
  readonly surfaceCloses: number;
  readonly botForgets: Readonly<Record<string, number>>;
  readonly clear: (tabId: string) => void;
  /** The channel's bot is gone: there is nothing to return to. */
  readonly forgetBot: (botId: string) => void;
  /** The surface closed: reopening it later is not where the task came from. */
  readonly clearAll: () => void;
}

export const useMobileTabOriginStore = create<MobileTabOriginState>((set) => ({
  origin: null,
  surfaceCloses: 0,
  botForgets: {},
  clear: (tabId) => {
    set((state) => (state.origin?.tabId === tabId ? { origin: null } : state));
  },
  forgetBot: (botId) => {
    set((state) => ({
      botForgets: {
        ...state.botForgets,
        [botId]: forgetsOf(state, botId) + 1,
      },
      origin: state.origin?.botId === botId ? null : state.origin,
    }));
  },
  clearAll: () => {
    set((state) => ({ surfaceCloses: state.surfaceCloses + 1, origin: null }));
  },
}));

function forgetsOf(state: MobileTabOriginState, botId: string): number {
  return Object.hasOwn(state.botForgets, botId) ? state.botForgets[botId] : 0;
}

/** A transcript link's way back, as of when its opening was asked for. */
export interface StampedTracyOrigin {
  readonly botId: string;
  readonly surfaceCloses: number;
  readonly botForgets: number;
}

export function stampTracyOrigin(
  origin: TracyTranscriptOrigin,
): StampedTracyOrigin {
  const state = useMobileTabOriginStore.getState();
  return {
    botId: origin.botId,
    surfaceCloses: state.surfaceCloses,
    botForgets: forgetsOf(state, origin.botId),
  };
}

/**
 * An opening of task tab `tabId` has landed with the tab in front: `stamped`
 * is the Tracy transcript link that made it, and `null`, for any other
 * opening, spends the way back. So does a link whose bot or surface went
 * while the opening was in flight.
 */
export function recordMobileTabOrigin(
  tabId: string,
  stamped: StampedTracyOrigin | null,
): void {
  if (!isPhoneLayoutOnly()) return;
  const state = useMobileTabOriginStore.getState();
  if (
    stamped === null ||
    stamped.surfaceCloses !== state.surfaceCloses ||
    stamped.botForgets !== forgetsOf(state, stamped.botId)
  ) {
    state.clear(tabId);
    return;
  }
  useMobileTabOriginStore.setState({
    origin: { tabId, botId: stamped.botId },
  });
}

/** `focused` is what the strip now has in front; the way back stays only with its task. */
export function spendMobileTabOriginUnlessInFront(
  focused: TabRef | null,
): void {
  const { origin } = useMobileTabOriginStore.getState();
  if (origin === null) return;
  if (focused?.kind === "epic" && focused.id === origin.tabId) return;
  useMobileTabOriginStore.setState({ origin: null });
}
