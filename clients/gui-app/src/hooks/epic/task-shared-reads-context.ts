import { createContext } from "react";
import type { TaskHostsView } from "@/hooks/epic/use-task-hosts-view";
import type { EpicCollaboratorsView } from "@/hooks/epics/use-epic-collaborators-query";

/*
 * The task's shared host reads, as a surface that observes them holds them,
 * for the components beneath it. A component mounted many times under that
 * surface - a windowed list's rows, mounting as it scrolls - reads these
 * instead of observing the query itself: a refused read holds no data, so
 * every observer that mounts onto it asks the host again, and each refusal
 * re-renders every reader. One context per read, so a change to one wakes
 * only its own readers. Null outside such a surface; a reader for another
 * task ignores it.
 */

export interface SharedTaskHosts {
  readonly epicId: string;
  readonly view: TaskHostsView;
}

export interface SharedTaskCollaborators {
  readonly epicId: string;
  readonly collaborators: EpicCollaboratorsView | undefined;
}

export const SharedTaskHostsContext = createContext<SharedTaskHosts | null>(
  null,
);

export const SharedTaskCollaboratorsContext =
  createContext<SharedTaskCollaborators | null>(null);
