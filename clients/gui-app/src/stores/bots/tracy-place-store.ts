import { create } from "zustand";
import type {
  TracyChannelView,
  TracyPlaceSession,
} from "@/lib/bots/tracy-place";

/**
 * Where the Tracy surface is, beside the rail each channel keeps
 * (`useBotOpenThreadStore`): Threads in place of the channel, and per channel
 * the view shown and the session shown in its place. Held here, above the
 * panes, so the surface's route can record a move as a history step and a
 * step back or forward can put the surface where it was
 * (`useTracyPlaceRoute`). Session-only, like the rail.
 *
 * `automaticMoves` counts the moves nobody made by hand (a landing asked of
 * the surface from outside it): the route records such a move over the
 * current entry and never as a step of its own.
 */
interface TracyPlaceState {
  readonly threadsShown: boolean;
  readonly viewByBotId: Readonly<Record<string, TracyChannelView>>;
  readonly sessionByBotId: Readonly<Record<string, TracyPlaceSession>>;
  readonly automaticMoves: number;
  readonly setThreadsShown: (shown: boolean) => void;
  readonly setView: (botId: string, view: TracyChannelView) => void;
  readonly setSession: (
    botId: string,
    session: TracyPlaceSession | null,
  ) => void;
  /** The move being made now is nobody's own. */
  readonly markAutomaticMove: () => void;
  /** Forgets a channel's view and session: it shows afresh next time. */
  readonly closeBot: (botId: string) => void;
  readonly closeSurface: () => void;
}

function without<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Readonly<Record<string, T>> {
  if (!Object.hasOwn(record, key)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}

export const useTracyPlaceStore = create<TracyPlaceState>()((set, get) => ({
  threadsShown: false,
  viewByBotId: {},
  sessionByBotId: {},
  automaticMoves: 0,
  setThreadsShown: (shown) => {
    if (get().threadsShown !== shown) set({ threadsShown: shown });
  },
  setView: (botId, view) => {
    const { viewByBotId } = get();
    if (tracyViewOf(viewByBotId, botId) === view) return;
    set({
      viewByBotId:
        view === "messages"
          ? without(viewByBotId, botId)
          : { ...viewByBotId, [botId]: view },
    });
  },
  setSession: (botId, session) => {
    const { sessionByBotId } = get();
    const current = tracySessionOf(sessionByBotId, botId);
    if (
      current?.chatId === session?.chatId &&
      current?.threadId === session?.threadId
    ) {
      return;
    }
    set({
      sessionByBotId:
        session === null
          ? without(sessionByBotId, botId)
          : { ...sessionByBotId, [botId]: session },
    });
  },
  markAutomaticMove: () => set({ automaticMoves: get().automaticMoves + 1 }),
  closeBot: (botId) => {
    const { viewByBotId, sessionByBotId } = get();
    const nextViews = without(viewByBotId, botId);
    const nextSessions = without(sessionByBotId, botId);
    if (nextViews === viewByBotId && nextSessions === sessionByBotId) return;
    set({ viewByBotId: nextViews, sessionByBotId: nextSessions });
  },
  closeSurface: () => {
    const state = get();
    if (
      !state.threadsShown &&
      Object.keys(state.viewByBotId).length === 0 &&
      Object.keys(state.sessionByBotId).length === 0
    ) {
      return;
    }
    set({ threadsShown: false, viewByBotId: {}, sessionByBotId: {} });
  },
}));

/** A channel's view: Messages until another is chosen. */
export function tracyViewOf(
  viewByBotId: Readonly<Record<string, TracyChannelView>>,
  botId: string,
): TracyChannelView {
  return Object.hasOwn(viewByBotId, botId) ? viewByBotId[botId] : "messages";
}

/** The session shown in place of a channel, or `null`. */
export function tracySessionOf(
  sessionByBotId: Readonly<Record<string, TracyPlaceSession>>,
  botId: string,
): TracyPlaceSession | null {
  return Object.hasOwn(sessionByBotId, botId) ? sessionByBotId[botId] : null;
}
