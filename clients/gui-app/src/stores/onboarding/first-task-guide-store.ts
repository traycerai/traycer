import { create } from "zustand";
import {
  sessionImportRunFor,
  useSessionImportRunStore,
  type SessionImportRunState,
  type SessionImportRunsState,
} from "@/stores/session-import/session-import-run-store";

export interface FirstTaskImport {
  readonly hostId: string;
  readonly epicId: string;
  readonly chatId: string;
  readonly title: string;
}

export type FirstTaskHint =
  | "folder"
  | "workspace"
  | "prompt"
  | "imported"
  | "continue"
  // The mobile branch, for an account that already has tasks. Neither is ever
  // acknowledged: both are derived from the navigation drawer's open state,
  // and an acknowledged hint never comes back - which would strand a user who
  // opened the drawer and closed it again without picking anything.
  | "tasks-menu"
  | "tasks-pick";

interface FirstTaskGuideState {
  readonly acknowledgedHints: ReadonlySet<FirstTaskHint>;
  readonly acknowledgeHint: (hint: FirstTaskHint) => void;
  readonly status: "inactive" | "active" | "finished";
  readonly imports: ReadonlyMap<string, SessionImportRunState>;
  readonly workspaceReviewed: boolean;
  readonly prepare: () => void;
  readonly activate: () => void;
  readonly dismiss: () => void;
  readonly reviewWorkspace: () => void;
  readonly rememberImport: (hostId: string) => void;
  readonly observeImports: (runs: SessionImportRunsState) => void;
  readonly messageSubmitted: (hostId: string | null, chatId: string) => void;
}

// Session-local: only finishing this onboarding arms the guide. Existing
// users and subsequent app launches never acquire another tutorial.
export const useFirstTaskGuideStore = create<FirstTaskGuideState>(
  (set, get) => ({
    acknowledgedHints: new Set(),
    acknowledgeHint: (hint) =>
      set((state) =>
        state.acknowledgedHints.has(hint)
          ? state
          : { acknowledgedHints: new Set(state.acknowledgedHints).add(hint) },
      ),
    status: "inactive",
    imports: new Map(),
    workspaceReviewed: false,
    prepare: () =>
      set({
        status: "inactive",
        imports: new Map(),
        workspaceReviewed: false,
        acknowledgedHints: new Set(),
      }),
    activate: () => set({ status: "active" }),
    dismiss: () => set({ status: "finished" }),
    reviewWorkspace: () => set({ workspaceReviewed: true }),
    rememberImport: (hostId) => {
      const run = sessionImportRunFor(
        useSessionImportRunStore.getState(),
        hostId,
      );
      if (run.status === "idle") return;
      set((state) => ({
        imports: new Map(state.imports).set(
          hostId,
          foldRememberedRun(state.imports.get(hostId), run),
        ),
      }));
    },
    observeImports: ({ runs }) => {
      const state = get();
      if (state.status === "finished") return;
      let imports = state.imports;
      for (const [hostId, previous] of state.imports) {
        const run = runs.get(hostId);
        if (!run || run === previous || run.status === "idle") continue;
        if (previous.runId !== null && previous.runId !== run.runId) continue;
        const folded = foldRememberedRun(previous, run);
        if (folded !== previous) imports = new Map(imports).set(hostId, folded);
      }
      if (imports !== state.imports) set({ imports });
    },
    messageSubmitted: (hostId, chatId) => {
      const state = get();
      if (state.status !== "active") return;
      const tasks = firstTaskImports(state.imports);
      if (
        tasks.length === 0 ||
        tasks.some((task) => task.hostId === hostId && task.chatId === chatId)
      ) {
        set({ status: "finished" });
      }
    },
  }),
);

/**
 * A host's remembered run, with a newer run of that host folded into it.
 * "Import more" starts a SECOND run on the same host, and the tasks the first
 * one brought in still belong to the guide - so what is kept is the union
 * keyed by selection key, the newer run winning a repeat.
 *
 * Returns the slice it was given when the fold changes nothing, so an
 * unrelated frame of the import store re-renders no reader of this one.
 */
function foldRememberedRun(
  previous: SessionImportRunState | undefined,
  run: SessionImportRunState,
): SessionImportRunState {
  if (previous === undefined) return run;
  const folded: SessionImportRunState = {
    ...run,
    outcomes: new Map([...previous.outcomes, ...run.outcomes]),
    titles: new Map([...previous.titles, ...run.titles]),
  };
  return previous.status === folded.status &&
    previous.runId === folded.runId &&
    previous.total === folded.total &&
    sameFinalCounts(previous.finalCounts, folded.finalCounts) &&
    sameEntries(previous.outcomes, folded.outcomes) &&
    sameEntries(previous.titles, folded.titles)
    ? previous
    : folded;
}

function sameFinalCounts(
  a: SessionImportRunState["finalCounts"],
  b: SessionImportRunState["finalCounts"],
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.imported === b.imported &&
    a.skippedAlreadyImported === b.skippedAlreadyImported &&
    a.failed === b.failed
  );
}

function sameEntries<T>(
  a: ReadonlyMap<string, T>,
  b: ReadonlyMap<string, T>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

export function firstTaskImports(
  imports: ReadonlyMap<string, SessionImportRunState>,
): readonly FirstTaskImport[] {
  const tasks: FirstTaskImport[] = [];
  for (const [hostId, run] of imports) {
    for (const entry of run.outcomes.values()) {
      if (entry.outcome.kind === "failed") continue;
      tasks.push({
        hostId,
        epicId: entry.outcome.epicId,
        chatId: entry.outcome.chatId,
        title: run.titles.get(entry.selectionKey) ?? "Imported task",
      });
    }
  }
  return tasks;
}

export function firstTaskImportPending(
  imports: ReadonlyMap<string, SessionImportRunState>,
): boolean {
  return [...imports.values()].some(
    (run) => run.status === "starting" || run.status === "running",
  );
}
