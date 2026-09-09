import { create } from "zustand";
import type { StreamSyncingSpell } from "@/lib/sync/stream-syncing-state";

/**
 * How far OUT a surface sits. Lower wins when several are syncing at once.
 *
 * An app switch drops every stream in the same tick, so this is the ordinary
 * case rather than an edge one: the app-wide session, the Epic's stream and a
 * chat's are all away together and all describing the same interruption. The
 * outermost one that is speaking owns the indicator, and each inner surface
 * takes over as the one above it recovers - the streams restore staggered, so
 * the hand-offs are what keep the indicator continuous from the first drop
 * until everything on screen is current.
 */
export const SURFACE_SYNC_RANK = {
  /** This client's whole transport. Nothing below it is meaningful while it is down. */
  session: 0,
  /** The Epic's stream: the canvas, the tab list and every sidebar panel. */
  epic: 1,
  /** One chat's stream: its transcript alone. */
  chat: 2,
} as const;

export interface SurfaceSyncEntry {
  /** See {@link SURFACE_SYNC_RANK}. */
  readonly rank: number;
  /** Names what is re-syncing for a screen reader ("Task", "Chat"). */
  readonly label: string;
  readonly spell: StreamSyncingSpell;
  /** Wakes THIS surface's own transport. `null` when there is none to wake. */
  readonly wake: (() => void) | null;
}

interface SurfaceSyncState {
  readonly entries: Readonly<Record<string, SurfaceSyncEntry>>;
  readonly publish: (key: string, entry: SurfaceSyncEntry) => void;
  readonly withdraw: (key: string) => void;
}

/**
 * What every surface is reporting about its own stream, so ONE element can
 * render for all of them.
 *
 * Surfaces publish here instead of rendering their own bar. Three bars at three
 * mount points meant the indicator was a different DOM element depending on
 * which stream was speaking - so each hand-off restarted the CSS animation from
 * its first frame (which always runs forward, reading as a repeat rather than a
 * bounce) and moved the bar down the screen by the height of whatever header it
 * had been mounted under. One element, fed by this, moves and restarts for
 * neither reason: only the DATA behind it changes across a hand-off.
 *
 * A store rather than context because the publishers are spread across the tree
 * and the consumer is above all of them.
 */
export const useSurfaceSyncStore = create<SurfaceSyncState>()((set) => ({
  entries: {},
  publish: (key, entry) => {
    set((state) => {
      const current = Object.hasOwn(state.entries, key)
        ? state.entries[key]
        : null;
      if (
        current !== null &&
        current.rank === entry.rank &&
        current.label === entry.label &&
        current.wake === entry.wake &&
        current.spell.syncing === entry.spell.syncing &&
        current.spell.escalated === entry.spell.escalated
      ) {
        // Identical report. Returning the same state keeps the consumer from
        // re-rendering on every publish, which surfaces do on every render.
        return state;
      }
      return { entries: { ...state.entries, [key]: entry } };
    });
  },
  withdraw: (key) => {
    set((state) => {
      if (!Object.hasOwn(state.entries, key)) return state;
      const next = { ...state.entries };
      delete next[key];
      return { entries: next };
    });
  },
}));

/**
 * The one surface whose indicator should be on screen, or `null` when none is.
 *
 * Ties break on the key so the answer is stable: two surfaces at the same rank
 * (two chats, if a future layout shows two at once) must not swap the
 * indicator's subject back and forth as unrelated state churns.
 */
export function resolveSurfaceSync(
  entries: Readonly<Record<string, SurfaceSyncEntry>>,
): { readonly key: string; readonly entry: SurfaceSyncEntry } | null {
  let best: { key: string; entry: SurfaceSyncEntry } | null = null;
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry.spell.syncing) continue;
    if (
      best === null ||
      entry.rank < best.entry.rank ||
      (entry.rank === best.entry.rank && key < best.key)
    ) {
      best = { key, entry };
    }
  }
  return best;
}
