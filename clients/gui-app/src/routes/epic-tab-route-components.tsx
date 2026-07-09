import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { TaskLight } from "@traycer/protocol/host/epic/unary-schemas";
import { EpicShell } from "@/components/epic-canvas/epic-shell";
import { EpicRouteSessionBody } from "@/components/epic-canvas/epic-route-session-body";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import { usePhaseMigrateToEpic } from "@/hooks/migration/use-phase-migrate-to-epic-mutation";
import { EpicSessionProvider } from "@/providers/epic-session-provider";
import {
  navigateToTabIntent,
  openOrFocusEpicIntent,
} from "@/lib/tab-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicFocusSearch } from "./epic-route-search";

export function EpicRoute() {
  const { epicId, tabId } = useParams({ from: "/epics/$epicId/$tabId" });
  const search = useSearch({ from: "/epics/$epicId/$tabId" });

  if (search.migrationSource === "phase") {
    return <PhaseToEpicMigrationGate phaseId={epicId} search={search} />;
  }

  return <EpicRouteTabSync epicId={epicId} tabId={tabId} search={search} />;
}

/**
 * The visible epic body is rendered by `EpicTabHost` (a keep-alive pane per
 * open tab), not here. This route component only performs router -> canvas
 * store synchronization, and is intentionally reactive to param changes - it
 * is no longer remounted on every switch (the old `key={epicId:tabId}` is
 * gone), so the sync cannot live in a mount-only effect.
 */
function EpicRouteTabSync(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly search: EpicFocusSearch;
}) {
  const { epicId, tabId, search } = props;
  const navigate = useNavigate();
  const routeTab = useEpicCanvasStore((s) => s.tabsById[tabId] ?? null);
  const resolveTargetTabForEpic = useEpicCanvasStore(
    (s) => s.resolveTargetTabForEpic,
  );
  const setActiveTab = useEpicCanvasStore((s) => s.setActiveTab);
  const { tasks } = useCloudEpicTasksQuery(undefined, { enabled: true });
  const taskTitle = findCachedTaskTitle(tasks, epicId);
  // Guards the resolve-and-redirect path so a churning dependency (e.g. cloud
  // tasks resolving) can't create twice for the same missing route id
  // before the replace-navigate lands.
  const resolvedForRouteRef = useRef<string | null>(null);

  useEffect(() => {
    const tab = useEpicCanvasStore.getState().tabsById[tabId];
    // Keep the URL's tab as the active tab so the tab strip highlights it.
    if (tab?.epicId === epicId) {
      resolvedForRouteRef.current = null;
      setActiveTab(tabId);
      return;
    }
    // Deep link / stale tab id with no record yet: reuse the preserved tab
    // for this epic when one exists, otherwise create one, then rewrite the
    // URL to the resolved id.
    const routeKey = `${epicId}\x1f${tabId}`;
    if (resolvedForRouteRef.current === routeKey) return;
    resolvedForRouteRef.current = routeKey;
    const resolvedTabId = resolveTargetTabForEpic(epicId, taskTitle);
    void navigate({
      to: "/epics/$epicId/$tabId",
      params: { epicId, tabId: resolvedTabId },
      search,
      replace: true,
    });
  }, [
    epicId,
    tabId,
    taskTitle,
    navigate,
    resolveTargetTabForEpic,
    setActiveTab,
    search,
  ]);

  // Until the tab record exists the host has no pane to show; render a themed
  // skeleton (never a blank/black frame). Once it exists the host's pane paints
  // over this and the route contributes nothing.
  if (routeTab?.epicId !== epicId) {
    return <EpicShell epicId={epicId} tabId={tabId} active />;
  }
  return null;
}

export function PhaseToEpicMigrationGate(props: {
  readonly phaseId: string;
  readonly search: EpicFocusSearch;
}) {
  return <PhaseToEpicMigrationGateInner key={props.phaseId} {...props} />;
}

function PhaseToEpicMigrationGateInner(props: {
  readonly phaseId: string;
  readonly search: EpicFocusSearch;
}) {
  const navigate = useNavigate();
  const migration = usePhaseMigrateToEpic(props.phaseId);
  const [migratedEpicId, setMigratedEpicId] = useState<string | null>(null);
  const [isTakingLonger, setIsTakingLonger] = useState(false);
  const startedRef = useRef(false);
  const openMigratedEpic = useCallback(
    (epicId: string) => {
      // Local state wins for the first paint - the gate shows the migrated
      // Epic body immediately, before the navigate below commits.
      setMigratedEpicId(epicId);
      // If the migration produced a different epic id than the phase id we
      // arrived with, route to that Epic so the URL reflects the new entity.
      // The intent's default focus carries `migrationSource: undefined`, so
      // this navigation also clears the migration flag.
      if (epicId !== props.phaseId) {
        navigateToTabIntent(
          navigate,
          openOrFocusEpicIntent({ epicId, focus: undefined }),
        );
        return;
      }
      // Same-id in-place migration (the "phase already resolves to v200"
      // fast-path): clear `migrationSource` THROUGH the router rather than via
      // a raw `history.replaceState`. The hoisted layout sidebar reads the
      // route's `migrationSource` reactively (it suppresses itself while a
      // phase migration owns the screen); a bare `replaceState` rewrites only
      // the URL bar, not the router's search state, so the sidebar stayed
      // hidden - and cmd+b dead, since its handler is mounted inside the
      // unrendered sidebar column - until the next real navigation.
      void navigate({
        to: ".",
        search: (prev) => ({ ...prev, migrationSource: undefined }),
        replace: true,
      });
    },
    [navigate, props.phaseId],
  );

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    migration.mutate(
      { phaseId: props.phaseId },
      { onSuccess: (data) => openMigratedEpic(data.epicId) },
    );
  }, [migration, openMigratedEpic, props.phaseId]);

  useEffect(() => {
    if (!migration.isPending) return;
    const timer = window.setTimeout(() => setIsTakingLonger(true), 15_000);
    return () => window.clearTimeout(timer);
  }, [migration.isPending]);

  const completedEpicId = migratedEpicId ?? migration.data?.epicId ?? null;
  if (completedEpicId !== null) {
    const resolvedTabId = useEpicCanvasStore
      .getState()
      .resolveTargetTabForEpic(completedEpicId, undefined);
    return (
      <EpicSessionProvider epicId={completedEpicId} tabId={resolvedTabId}>
        <EpicRouteSessionBody
          epicId={completedEpicId}
          tabId={resolvedTabId}
          active
          focusedAt={props.search.focusedAt}
          focusArtifactId={props.search.focusArtifactId}
          focusThreadId={props.search.focusThreadId}
          focusPaneId={props.search.focusPaneId}
          focusTileInstanceId={props.search.focusTileInstanceId}
        />
      </EpicSessionProvider>
    );
  }

  return (
    <div
      data-testid="phase-to-epic-migration-screen"
      className="flex min-h-0 flex-1 items-center justify-center bg-background px-4 py-6"
    >
      <section className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-lg">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-foreground">
            {migration.isError ? (
              <span className="text-ui-sm font-semibold">!</span>
            ) : (
              <AgentSpinningDots
                className="text-foreground"
                testId="phase-to-epic-migration-spinner"
                variant="dots"
              />
            )}
          </div>
          <div className="min-w-0 space-y-2">
            <h2 className="text-ui-sm font-semibold text-foreground">
              Migrating Phase to Epic
            </h2>
            <p className="text-ui-sm leading-6 text-muted-foreground">
              Converting this legacy Phase into an Epic. Phase tasks are being
              turned into tickets, and saved plans or verification notes are
              being attached as spec and review artifacts.
            </p>
            {isTakingLonger ? (
              <p className="text-ui-sm leading-6 text-muted-foreground">
                Still migrating. Larger Phases can take a little longer while
                the desktop host copies the room and uploads the Epic.
              </p>
            ) : null}
            {migration.isError ? (
              <p
                className="text-ui-sm leading-6 text-destructive"
                data-testid="phase-to-epic-migration-error"
              >
                {migration.error.message}
              </p>
            ) : null}
            {migration.isError ? (
              <Button
                onClick={() =>
                  migration.mutate(
                    { phaseId: props.phaseId },
                    { onSuccess: (data) => openMigratedEpic(data.epicId) },
                  )
                }
                size="sm"
                type="button"
                variant="outline"
              >
                Re-attempt migration
              </Button>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function findCachedTaskTitle(
  tasks: ReadonlyArray<TaskLight>,
  epicId: string,
): string {
  const match = tasks.find(
    (task) =>
      task.epic?.light?.id === epicId || task.phase?.light?.id === epicId,
  );
  return match?.epic?.light?.title ?? match?.phase?.light?.title ?? "";
}
