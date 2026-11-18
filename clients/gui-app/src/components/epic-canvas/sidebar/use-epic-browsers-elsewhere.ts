import { useMemo } from "react";
import { useBrowserSessionsPlane } from "@/hooks/home-focus/use-browser-sessions-plane";

/** One other machine this task currently has open browser tabs on. */
export interface EpicBrowsersElsewhere {
  readonly hostId: string;
  readonly tabCount: number;
}

const NONE: readonly EpicBrowsersElsewhere[] = [];

/**
 * This task's open browser tabs on machines OTHER than the one the Browsers
 * panel is currently showing.
 *
 * The panel lists exactly one host, and its default is the task's sole agent
 * host. That was the whole answer while a task's browsers could only run where
 * its agents do. An agent on another machine can now have its browser placed
 * on the machine the user is sitting at - so the panel's default host can
 * legitimately have nothing while the task has a live, agent-driven tab one
 * host away, and the panel would say "No browsers yet" about a tab the user
 * can see a tile of.
 *
 * ## It reads the registry and acquires nothing
 *
 * Same seam and same reason as Home's plane: an inventory that brought its own
 * subject into existence would open a stream per host just to answer whether
 * that host has anything. What it sees is what some other surface already
 * holds - the canvas provider's stream, and any open tile's. So the answer is
 * honestly window-local: it names hosts this window is already listening to,
 * never every host in the fleet, and a machine this window holds no stream to
 * is not named even when the task has a browser there.
 *
 * A session whose tabs are all closing counts for nothing, the same rule the
 * chat's session row applies before it offers to open one.
 */
export function useEpicBrowsersElsewhere(args: {
  readonly epicId: string;
  readonly resolvedHostId: string | null;
}): readonly EpicBrowsersElsewhere[] {
  const { epicId, resolvedHostId } = args;
  const browserEpics = useBrowserSessionsPlane();
  return useMemo(() => {
    const forEpic = browserEpics.find((epic) => epic.epicId === epicId);
    if (forEpic === undefined) return NONE;
    const tabsByHostId = new Map<string, number>();
    for (const session of forEpic.sessions) {
      if (session.hostId === resolvedHostId) continue;
      const openTabs = session.tabs.filter(
        (tab) => tab.status !== "closing",
      ).length;
      if (openTabs === 0) continue;
      tabsByHostId.set(
        session.hostId,
        (tabsByHostId.get(session.hostId) ?? 0) + openTabs,
      );
    }
    if (tabsByHostId.size === 0) return NONE;
    return [...tabsByHostId]
      .map(([hostId, tabCount]) => ({ hostId, tabCount }))
      .sort((left, right) => left.hostId.localeCompare(right.hostId));
  }, [browserEpics, epicId, resolvedHostId]);
}
