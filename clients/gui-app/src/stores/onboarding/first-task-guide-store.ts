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
  | "continue";

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
      set((state) => ({ imports: new Map(state.imports).set(hostId, run) }));
    },
    observeImports: ({ runs }) => {
      const state = get();
      if (state.status === "finished") return;
      let imports = state.imports;
      for (const [hostId, previous] of state.imports) {
        const run = runs.get(hostId);
        if (!run || run === previous || run.status === "idle") continue;
        if (previous.runId !== null && previous.runId !== run.runId) continue;
        imports = new Map(imports).set(hostId, run);
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
