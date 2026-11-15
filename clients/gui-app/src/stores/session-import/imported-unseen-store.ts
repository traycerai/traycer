import { create } from "zustand";
import { z } from "zod";
import {
  guiHarnessIdSchema,
  type GuiHarnessId,
} from "@traycer/protocol/host/index";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import {
  recordMapStorageKey,
  recordMapStoragePrefix,
} from "@/lib/persist/keys";

/**
 * Imported tasks the user has not opened yet, keyed by epic id with the source
 * provider as the value (it feeds the dot's tooltip), or `null` when the task
 * holds imported work from MORE THAN ONE provider.
 *
 * The neutral value stopped being an edge case when import moved to one task
 * per repository: a person who ran both Claude and Codex in the same checkout
 * now gets one task holding both, and last-write-wins on the harness would put
 * "Imported from Codex" on a task that is half Claude's. `null` is the honest
 * answer there, and the dot says so without naming a provider.
 *
 * This is the task list's unread dot for imports: deliberately app-local
 * client state rather than notifications - fifty feed entries per import run
 * would be spam in the bell, and the notifications domain's dual-plane
 * machinery is far too heavy for a one-time "you haven't looked at this yet"
 * hint. The trade is that the dot shows only on the machine that ran the
 * import, which is the machine the user imported on.
 *
 * Persisted so a restart between importing and looking does not erase the
 * hint; entries clear the first time the task is opened (the epic surface
 * mounting is the one funnel every open path goes through).
 *
 * Every entry is its own storage key, and a mark or an open touches only its
 * own. An import marks one entry per session, and an unopened task keeps its
 * entry across runs, so the set reaches thousands: rewriting all of it on
 * each mark made an import's cost grow with every task it had already made.
 */
type UnseenHarness = GuiHarnessId | null;

interface ImportedUnseenState {
  /**
   * Moves on every change to the set, which lives outside the state so a mark
   * is not a copy of it. Read an entry with {@link useImportedUnseen}.
   */
  readonly revision: number;
  readonly markImported: (epicId: string, harness: GuiHarnessId) => void;
  readonly markSeen: (epicId: string) => void;
}

const UNSEEN_KEY = persistKey(STORE_KEYS.sessionImportUnseen);
const entrySchema = z.object({ harness: guiHarnessIdSchema.nullable() });
const legacySnapshotSchema = z.object({
  state: z.object({ unseen: z.record(z.string(), z.unknown()) }),
});

function parseEntry(raw: string | null): UnseenHarness | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = entrySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.harness : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The single record every earlier build kept under {@link UNSEEN_KEY}, moved
 * to one key per entry and then removed. An entry the new layout already holds
 * wins over the old record's.
 */
function migrateLegacySnapshot(): void {
  const raw = localStorage.getItem(UNSEEN_KEY);
  if (raw === null) return;
  let entries: Record<string, unknown> = {};
  try {
    const parsed = legacySnapshotSchema.safeParse(JSON.parse(raw));
    if (parsed.success) entries = parsed.data.state.unseen;
  } catch {
    // An unreadable record has nothing to move.
  }
  for (const [epicId, value] of Object.entries(entries)) {
    const harness = guiHarnessIdSchema.nullable().safeParse(value);
    if (!harness.success) continue;
    const key = recordMapStorageKey(UNSEEN_KEY, epicId);
    if (localStorage.getItem(key) === null)
      localStorage.setItem(key, JSON.stringify({ harness: harness.data }));
  }
  localStorage.removeItem(UNSEEN_KEY);
}

function loadUnseen(): Map<string, UnseenHarness> {
  const unseen = new Map<string, UnseenHarness>();
  try {
    migrateLegacySnapshot();
    const prefix = recordMapStoragePrefix(UNSEEN_KEY);
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key === null || !key.startsWith(prefix)) continue;
      const harness = parseEntry(localStorage.getItem(key));
      if (harness !== undefined)
        unseen.set(decodeURIComponent(key.slice(prefix.length)), harness);
    }
  } catch {
    // Storage unavailable: the dots start empty, as a fresh profile's do.
  }
  return unseen;
}

function writeEntry(epicId: string, harness: UnseenHarness): void {
  try {
    localStorage.setItem(
      recordMapStorageKey(UNSEEN_KEY, epicId),
      JSON.stringify({ harness }),
    );
  } catch {
    // Storage full or unavailable: the dot still shows for this session.
  }
}

function removeEntry(epicId: string): void {
  try {
    localStorage.removeItem(recordMapStorageKey(UNSEEN_KEY, epicId));
  } catch {
    // Storage unavailable: the entry is already gone from this session.
  }
}

const unseen = loadUnseen();

export const useImportedUnseenStore = create<ImportedUnseenState>()((set) => ({
  revision: 0,
  markImported: (epicId, harness) => {
    const known = unseen.has(epicId);
    const existing = unseen.get(epicId);
    // Already neutral stays neutral, and a second provider landing on a
    // task the first one marked goes neutral: the dot names a provider only
    // while that is the whole truth about the task.
    const next = !known || existing === harness ? harness : null;
    if (known && existing === next) return;
    unseen.set(epicId, next);
    writeEntry(epicId, next);
    set((state) => ({ revision: state.revision + 1 }));
  },
  markSeen: (epicId) => {
    if (!unseen.delete(epicId)) return;
    removeEntry(epicId);
    set((state) => ({ revision: state.revision + 1 }));
  },
}));

/**
 * One task's unseen import: `undefined` when there is none, `null` when it
 * holds several providers' work, else that provider. A mark re-renders only
 * the readers whose entry it changed.
 */
export function useImportedUnseen(epicId: string): UnseenHarness | undefined {
  return useImportedUnseenStore(() => unseen.get(epicId));
}
