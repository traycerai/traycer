import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  useRouter,
  useRouterState,
  type NavigateOptions,
} from "@tanstack/react-router";
import {
  railOfTracyPlace,
  tracyPlaceKey,
  tracyPlaceOfSearch,
  tracyPlaceRailKey,
  tracyPlaceRailOf,
  tracyPlaceSearch,
  type TracyPlace,
} from "@/lib/bots/tracy-place";
import {
  historyEntryIdentity,
  takeTracyPlaceStep,
} from "@/lib/bots/tracy-place-traversal";
import {
  subscribeTabNavigationPending,
  tracyNavigationPending,
} from "@/lib/tab-navigation";
import { applyRouteBookkeeping } from "@/lib/tab-navigation/route-bookkeeping";
import { isRecord } from "@/lib/editor/prosemirror-json";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import {
  tracySessionOf,
  tracyViewOf,
  useTracyPlaceStore,
} from "@/stores/bots/tracy-place-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";

/**
 * Rides in the history state of every entry this hook writes: the number of
 * the write, so its own commit is told from every other arrival.
 */
const TRACY_PLACE_WRITE_KEY = "__traycerTracyPlaceWrite";

let placeWrites = 0;

/** Where the surface's stores say it is, on `botId`'s channel or on none. */
function readTracyPlace(botId: string | null): TracyPlace {
  const place = useTracyPlaceStore.getState();
  if (botId === null) {
    return {
      view: "messages",
      threadsShown: place.threadsShown,
      session: null,
      thread: null,
      memory: false,
      exchangePeerBotId: null,
    };
  }
  const { byBotId } = useBotOpenThreadStore.getState();
  return {
    view: tracyViewOf(place.viewByBotId, botId),
    threadsShown: place.threadsShown,
    session: tracySessionOf(place.sessionByBotId, botId),
    ...tracyPlaceRailOf(Object.hasOwn(byBotId, botId) ? byBotId[botId] : null),
  };
}

/**
 * Puts the surface where `place` says. Threads takes the place of a session,
 * so a place naming both shows Threads; with no channel only Threads can
 * show. A rail already on the place is left as it is, a search over it
 * included.
 */
function applyTracyPlace(botId: string | null, place: TracyPlace): void {
  const store = useTracyPlaceStore.getState();
  store.setThreadsShown(place.threadsShown);
  if (botId === null) return;
  store.setView(botId, place.view);
  store.setSession(botId, place.threadsShown ? null : place.session);
  const rails = useBotOpenThreadStore.getState();
  const rail = Object.hasOwn(rails.byBotId, botId)
    ? rails.byBotId[botId]
    : null;
  if (tracyPlaceRailKey(tracyPlaceRailOf(rail)) === tracyPlaceRailKey(place)) {
    return;
  }
  rails.setRail(botId, railOfTracyPlace(place, rail));
}

/**
 * Keeps the Tracy route's place and the surface in step, the way a task's
 * route and its canvas are: the surface's stores say where it is, a move the
 * person makes there is PUSHED onto the route as a history step, and a step
 * back or forward onto an entry puts the surface where that entry says.
 *
 * - An entry naming no place (written before places were, or by an opener
 *   for the channel alone) is completed over itself, never read as a move.
 * - An arrival that is no step is the app's own write: the stores stand, and
 *   an entry that disagrees with them is corrected over itself.
 * - A move nobody made by hand (`markAutomaticMove`) is recorded over the
 *   current entry, so it leaves no step of its own.
 *
 * Nothing is written while the surface has not caught up with the route's
 * channel, or while a navigation to the surface is in flight: its commit is
 * an arrival, handled then.
 */
export function useTracyPlaceRoute(botId: string | null): void {
  const router = useRouter();
  const location = useRouterState({ select: (state) => state.location });
  const surfaceOpen = useTracySurfaceStore((state) => state.open);
  const surfaceBotId = useTracySurfaceStore((state) => state.botId);
  const navigating = useSyncExternalStore(
    subscribeTabNavigationPending,
    tracyNavigationPending,
    () => false,
  );
  const threadsShown = useTracyPlaceStore((state) => state.threadsShown);
  const view = useTracyPlaceStore((state) =>
    botId === null ? "messages" : tracyViewOf(state.viewByBotId, botId),
  );
  const session = useTracyPlaceStore((state) =>
    botId === null ? null : tracySessionOf(state.sessionByBotId, botId),
  );
  const automaticMoves = useTracyPlaceStore((state) => state.automaticMoves);
  const railKey = useBotOpenThreadStore((state) =>
    tracyPlaceRailKey(
      tracyPlaceRailOf(
        botId !== null && Object.hasOwn(state.byBotId, botId)
          ? state.byBotId[botId]
          : null,
      ),
    ),
  );
  const seen = useRef<{
    readonly identity: string | null;
    readonly automaticMoves: number;
  }>({ identity: null, automaticMoves });
  const awaited = useRef(new Set<number>());

  useEffect(() => {
    if (!surfaceOpen || surfaceBotId !== botId || navigating) return;
    const write = (place: TracyPlace, mode: "push" | "replace"): void => {
      placeWrites += 1;
      const seq = placeWrites;
      awaited.current.add(seq);
      const search = tracyPlaceSearch(place);
      const target: NavigateOptions =
        botId === null
          ? { to: "/bot", search: (prev) => ({ ...prev, ...search }) }
          : {
              to: "/bot/$botId",
              params: { botId },
              search: (prev) => ({ ...prev, ...search }),
            };
      const options: NavigateOptions =
        mode === "replace"
          ? applyRouteBookkeeping({
              ...target,
              replace: true,
              state: (previous) => ({
                ...previous,
                [TRACY_PLACE_WRITE_KEY]: seq,
              }),
            })
          : {
              ...target,
              replace: false,
              // A step of its own carries nothing of the entry it leaves.
              state: (): Record<string, unknown> => ({
                [TRACY_PLACE_WRITE_KEY]: seq,
              }),
            };
      // Best-effort, as a task's focus write is: a commit that is refused or
      // superseded leaves the entry as it was, and the next move writes again.
      router.navigate(options).catch(() => undefined);
    };

    const identity = historyEntryIdentity(location);
    const arrived = seen.current.identity !== identity;
    const automatic = seen.current.automaticMoves !== automaticMoves;
    seen.current = { identity, automaticMoves };
    const routed = tracyPlaceOfSearch(location.search);
    const here = readTracyPlace(botId);
    const agrees =
      routed !== null && tracyPlaceKey(routed) === tracyPlaceKey(here);
    if (!arrived) {
      if (agrees) return;
      write(here, routed === null || automatic ? "replace" : "push");
      return;
    }
    const stepped = takeTracyPlaceStep(identity);
    const state: unknown = location.state;
    const mark = isRecord(state) ? state[TRACY_PLACE_WRITE_KEY] : undefined;
    const own = typeof mark === "number" && awaited.current.delete(mark);
    if (routed === null) {
      write(here, "replace");
      return;
    }
    if (agrees) return;
    if (stepped) {
      applyTracyPlace(botId, routed);
      const landed = readTracyPlace(botId);
      if (tracyPlaceKey(landed) !== tracyPlaceKey(routed)) {
        write(landed, "replace");
      }
      return;
    }
    // The person moved on while this hook's own write was committing: that
    // move is a step. Any other entry the app wrote is corrected over itself.
    write(here, own ? "push" : "replace");
  }, [
    automaticMoves,
    botId,
    location,
    navigating,
    railKey,
    router,
    session,
    surfaceBotId,
    surfaceOpen,
    threadsShown,
    view,
  ]);
}
