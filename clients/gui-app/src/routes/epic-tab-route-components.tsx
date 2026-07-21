import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  useNavigate,
  useParams,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
import { EpicShell } from "@/components/epic-canvas/epic-shell";
import { EpicRouteSessionBody } from "@/components/epic-canvas/epic-route-session-body";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { RootLandingPage } from "@/components/layout/root-landing-page";
import { usePhaseMigrateToEpic } from "@/hooks/migration/use-phase-migrate-to-epic-mutation";
import { EpicSessionProvider } from "@/providers/epic-session-provider";
import { createReportIssueContext } from "@/lib/report-issue-context";
import {
  activateTabIntent,
  completeEpicMigrationIntent,
  subscribeTabNavigationResolutionFailure,
  tabNavigationResolutionFailed,
} from "@/lib/tab-navigation";
import { parseNestedFocusTargetFromSearch } from "@/lib/epic-nested-focus-route";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicFocusSearch } from "./epic-route-search";

export function EpicRoute() {
  const { epicId, tabId } = useParams({ from: "/epics/$epicId/$tabId" });
  const search = useSearch({ from: "/epics/$epicId/$tabId" });

  if (search.migrationSource === "phase") {
    return (
      <PhaseToEpicMigrationGate
        phaseId={epicId}
        tabId={tabId}
        search={search}
      />
    );
  }

  return <EpicRouteTabSync epicId={epicId} tabId={tabId} />;
}

/** The root bridge owns every route -> store transition. This adapter renders. */
function EpicRouteTabSync(props: {
  readonly epicId: string;
  readonly tabId: string;
}) {
  const { epicId, tabId } = props;
  const routeTab = useEpicCanvasStore((s) => s.tabsById[tabId] ?? null);
  const routeTabIsOpen = useEpicCanvasStore((s) =>
    s.openTabOrder.includes(tabId),
  );
  const locationState = useRouterState({ select: (s) => s.location.state });
  const resolutionFailed = useSyncExternalStore(
    subscribeTabNavigationResolutionFailure,
    () => tabNavigationResolutionFailed(locationState),
    () => false,
  );

  if (resolutionFailed) return <RootLandingPage />;

  // Until the tab record exists the host has no pane to show; render a themed
  // skeleton (never a blank/black frame). Once it exists the host's pane paints
  // over this and the route contributes nothing.
  if (routeTab?.epicId !== epicId || !routeTabIsOpen) {
    return <EpicShell epicId={epicId} tabId={tabId} active />;
  }
  return null;
}

export function PhaseToEpicMigrationGate(props: {
  readonly phaseId: string;
  readonly tabId: string;
  readonly search: EpicFocusSearch;
}) {
  return (
    <PhaseToEpicMigrationGateInner
      key={`${props.phaseId}:${props.tabId}`}
      {...props}
    />
  );
}

function PhaseToEpicMigrationGateInner(props: {
  readonly phaseId: string;
  readonly tabId: string;
  readonly search: EpicFocusSearch;
}) {
  const navigate = useNavigate();
  const migration = usePhaseMigrateToEpic(props.phaseId);
  const [migratedEpicId, setMigratedEpicId] = useState<string | null>(null);
  const [migrationRoutingFailed, setMigrationRoutingFailed] = useState(false);
  const [isTakingLonger, setIsTakingLonger] = useState(false);
  const startedRef = useRef(false);
  const openMigratedEpic = useCallback(
    (epicId: string) => {
      const accepted = activateTabIntent(
        navigate,
        completeEpicMigrationIntent({
          sourceEpicId: props.phaseId,
          epicId,
          tabId: props.tabId,
          focus: {
            focusedAt: props.search.focusedAt,
            focusArtifactId: props.search.focusArtifactId,
            focusThreadId: props.search.focusThreadId,
            migrationSource: undefined,
          },
          nestedFocus: parseNestedFocusTargetFromSearch({ ...props.search }),
        }),
        { replace: true },
      );
      // The coordinator updates this exact source synchronously before the
      // route navigation; render it immediately while the owned replace ACKs.
      if (accepted) {
        setMigratedEpicId(epicId);
        setMigrationRoutingFailed(false);
      } else {
        setMigrationRoutingFailed(true);
      }
    },
    [navigate, props.phaseId, props.search, props.tabId],
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

  const completedEpicId = migratedEpicId;
  if (completedEpicId !== null) {
    return (
      <EpicSessionProvider epicId={completedEpicId} tabId={props.tabId}>
        <EpicRouteSessionBody
          epicId={completedEpicId}
          tabId={props.tabId}
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
            {migration.isError || migrationRoutingFailed ? (
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
            {migration.isError || migrationRoutingFailed ? (
              <p
                className="text-ui-sm leading-6 text-destructive"
                data-testid="phase-to-epic-migration-error"
              >
                {migration.isError
                  ? migration.error.message
                  : "The migrated Epic could not be attached to this tab."}
              </p>
            ) : null}
            {migration.isError || migrationRoutingFailed ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    setMigrationRoutingFailed(false);
                    migration.mutate(
                      { phaseId: props.phaseId },
                      { onSuccess: (data) => openMigratedEpic(data.epicId) },
                    );
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Re-attempt migration
                </Button>
                <ReportIssueAction
                  context={createReportIssueContext({
                    title: "Phase migration did not finish",
                    message: "The legacy Phase migration did not complete.",
                    code: null,
                    source: "Phase migration",
                  })}
                  presentation="text"
                  className={undefined}
                />
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
