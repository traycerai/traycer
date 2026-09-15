/**
 * Docs: see ../SETTINGS.md
 * Update that file whenever this settings surface changes.
 */
import { useId, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { ImportLoginsDialog } from "@/components/settings/import-logins-dialog";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsRow } from "@/components/settings/settings-row";
import { LessonCard } from "@/components/settings/panels/onboarding/lesson-card";
import {
  LessonDiorama,
  type LessonDioramaScene,
} from "@/components/settings/panels/onboarding/lesson-diorama";
import {
  summarizeOnboardingProgress,
  tourActionLabel,
  tourStatusLabel,
} from "@/components/settings/panels/onboarding/onboarding-progress";
import {
  ONBOARDING,
  ONBOARDING_LESSON_ROWS,
} from "@/components/settings/panels/onboarding-settings.definitions";
import { Button } from "@/components/ui/button";
import { useLoginImportAvailable } from "@/hooks/browser/use-login-import-available";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { useBrowserSaveLoginsEnabled } from "@/lib/browser-view/use-browser-save-logins";
import { isMobileApp } from "@/lib/mobile-app";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { isSettingsSectionVisible } from "@/lib/settings-sections";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import {
  selectOnboardingFlowData,
  useOnboardingFlowStore,
  type OnboardingFlowData,
} from "@/stores/onboarding/onboarding-flow-store";
import {
  TOUR_IDS,
  type LessonId,
  type TourId,
} from "@/stores/onboarding/onboarding-tour-catalog";
import {
  getSystemTabModalApi,
  useSystemTabModalApiPublished,
} from "@/stores/tabs/system-tab-modal-bridge";

/**
 * Settings ▸ Onboarding: the desktop learning page. A progress summary,
 * then the five guided tours, then the four lessons that are a demo, an
 * editor or a dialog rather than a tour.
 *
 * Progress is READ from the flow store and written back only through its
 * fixed actions - `replayTour` and `showWelcomeModalAgain` - so this page is
 * never a second authority over where the flow is. It does not play a tour
 * either: a replay writes the store and the tour host, which watches it,
 * takes the screen from there. Before either write, an OPEN Settings overlay
 * is closed through the published modal API - a tour under a modal dialog
 * would wait forever - which is why both actions hold until that API exists
 * rather than letting the close silently no-op. A Settings TAB stays open;
 * the tour host changes the active surface as it needs.
 *
 * The builds that omit the section (the mobile app) never list it and their
 * route redirects, but a retained `SettingsSurface` can still mount this
 * panel from a remembered path it resolved itself. The visibility check is
 * that last guard: there the page says so and mounts no lesson, no store
 * read and no dialog, rather than offering desktop lessons a phone cannot
 * run.
 */
export function OnboardingSettingsPanel(): ReactNode {
  const compact = useSettingsDensity() === "compact";
  const offered = isSettingsSectionVisible("onboarding");
  return (
    <SettingsPanelShell
      title={ONBOARDING.page.label}
      description={ONBOARDING.page.description}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <div
        data-testid="onboarding-settings-panel"
        data-lessons={offered ? "desktop" : "unavailable"}
        className={cn("flex flex-col", compact ? "gap-3.5" : "gap-5")}
      >
        {offered ? (
          <OnboardingLessons />
        ) : (
          <p className="max-w-[72ch] text-ui-sm text-muted-foreground">
            The tours and lessons cover the desktop app. Open Settings ▸
            Onboarding on your desktop to play them.
          </p>
        )}
      </div>
    </SettingsPanelShell>
  );
}

/** One `onboarding_lesson_opened` per action taken; never on render. */
function trackLessonOpened(lesson: LessonId): void {
  Analytics.getInstance().track(AnalyticsEvent.OnboardingLessonOpened, {
    lesson,
  });
}

/**
 * Close the Settings OVERLAY, if that is what is hosting this page, so the
 * flow has the screen. A Settings tab is left alone. Callers hold their
 * action until the API is published, so a `null` here is unreachable
 * rather than a silent no-op.
 */
function closeSettingsOverlay(): void {
  const api = getSystemTabModalApi();
  if (api === null) return;
  if (api.isOverlayActive("settings")) api.close();
}

function OnboardingLessons(): ReactNode {
  const flow = useOnboardingFlowStore(useShallow(selectOnboardingFlowData));
  const replayTour = useOnboardingFlowStore((state) => state.replayTour);
  const showWelcomeModalAgain = useOnboardingFlowStore(
    (state) => state.showWelcomeModalAgain,
  );
  const modalApiPublished = useSystemTabModalApiPublished();
  const [expandedDemo, setExpandedDemo] = useState<LessonDioramaScene | null>(
    null,
  );

  const replay = (tourId: TourId): void => {
    trackLessonOpened(tourId);
    closeSettingsOverlay();
    replayTour(tourId);
  };

  return (
    <>
      <OnboardingProgressGroup
        flow={flow}
        canAct={modalApiPublished}
        onShowWelcomeAgain={() => {
          closeSettingsOverlay();
          showWelcomeModalAgain();
        }}
      />

      <SettingsGroup
        group={ONBOARDING.definitions.guidedTours}
        showTitle
        tone="default"
        dataTestId="onboarding-guided-tours"
        fill={false}
      >
        {TOUR_IDS.map((tourId) => (
          <LessonCard
            key={tourId}
            lessonId={tourId}
            row={ONBOARDING_LESSON_ROWS[tourId]}
            labelStatus={tourStatusLabel(flow, tourId)}
            status={undefined}
            expanded={null}
            expandedId={`onboarding-demo-${tourId}`}
            control={
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!modalApiPublished}
                data-testid={`onboarding-replay-${tourId}`}
                onClick={() => {
                  replay(tourId);
                }}
              >
                {tourActionLabel(flow, tourId)}
              </Button>
            }
          />
        ))}
      </SettingsGroup>

      <SettingsGroup
        group={ONBOARDING.definitions.moreLessons}
        showTitle
        tone="default"
        dataTestId="onboarding-more-lessons"
        fill={false}
      >
        <DemoLessonCard
          scene="split-screen"
          expanded={expandedDemo === "split-screen"}
          onToggle={(open) => {
            setExpandedDemo(open ? "split-screen" : null);
          }}
        />
        <DemoLessonCard
          scene="task-tabs"
          expanded={expandedDemo === "task-tabs"}
          onToggle={(open) => {
            setExpandedDemo(open ? "task-tabs" : null);
          }}
        />
        <LessonCard
          lessonId="agent-guide"
          row={ONBOARDING_LESSON_ROWS["agent-guide"]}
          labelStatus={undefined}
          status={undefined}
          expanded={null}
          expandedId="onboarding-demo-agent-guide"
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!modalApiPublished}
              data-testid="onboarding-open-agent-guide"
              onClick={() => {
                trackLessonOpened("agent-guide");
                // The existing Agents page owns the editor: host scope,
                // seeding, autosave. This page only sends the user there.
                navigateToSettingsSection("agents");
              }}
            >
              Open editor
            </Button>
          }
        />
        <LoginImportLessonCard />
      </SettingsGroup>
    </>
  );
}

function OnboardingProgressGroup(props: {
  readonly flow: OnboardingFlowData;
  readonly canAct: boolean;
  readonly onShowWelcomeAgain: () => void;
}): ReactNode {
  const compact = useSettingsDensity() === "compact";
  const summary = summarizeOnboardingProgress(props.flow);
  const meterId = useId();
  return (
    <SettingsGroup
      group={ONBOARDING.definitions.progress}
      showTitle
      tone="default"
      dataTestId="onboarding-progress"
      fill={false}
    >
      <div
        data-testid="onboarding-progress-summary"
        className={cn(
          "space-y-2 border-b border-border/40",
          compact ? "px-4 py-2.5" : "px-5 py-4",
        )}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span id={meterId} className="font-medium text-foreground">
            {summary.done} of {summary.total} tours completed
          </span>
          <span className="text-ui-sm text-muted-foreground">
            Tours: {summary.chain}
          </span>
        </div>
        <div
          role="progressbar"
          aria-labelledby={meterId}
          aria-valuemin={0}
          aria-valuemax={summary.total}
          aria-valuenow={summary.done}
          className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10"
        >
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${(summary.done / summary.total) * 100}%` }}
          />
        </div>
        <p className="text-ui-sm text-muted-foreground">
          {summary.done} done · {summary.available} available ·{" "}
          {summary.bypassed} bypassed · {summary.active} active
        </p>
        {summary.legacyNote === null ? null : (
          <p
            data-testid="onboarding-legacy-note"
            className="max-w-[72ch] text-pretty text-ui-sm text-muted-foreground"
          >
            {summary.legacyNote}
          </p>
        )}
      </div>
      <SettingsRow
        row={ONBOARDING.definitions.welcome}
        labelStatus={summary.welcome}
        control={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!props.canAct}
            data-testid="onboarding-show-welcome-again"
            onClick={props.onShowWelcomeAgain}
          >
            Show welcome modal again
          </Button>
        }
      />
    </SettingsGroup>
  );
}

/**
 * A lesson whose surface is an inline miniature. At most one demo is open on
 * the page at a time - the parent holds which - so at most one set of demo
 * timers runs, and opening one closes the other.
 */
function DemoLessonCard(props: {
  readonly scene: LessonDioramaScene;
  readonly expanded: boolean;
  readonly onToggle: (open: boolean) => void;
}): ReactNode {
  const regionId = `onboarding-demo-${props.scene}`;
  return (
    <LessonCard
      lessonId={props.scene}
      row={ONBOARDING_LESSON_ROWS[props.scene]}
      labelStatus={undefined}
      status={undefined}
      expandedId={regionId}
      expanded={props.expanded ? <LessonDiorama scene={props.scene} /> : null}
      control={
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={props.expanded}
          aria-controls={props.expanded ? regionId : undefined}
          data-testid={`onboarding-demo-toggle-${props.scene}`}
          onClick={() => {
            // Opening is the lesson; closing is not, and neither is the
            // demo's own cycle.
            if (!props.expanded) trackLessonOpened(props.scene);
            props.onToggle(!props.expanded);
          }}
        >
          {props.expanded ? "Close demo" : "Watch demo"}
        </Button>
      }
    />
  );
}

/**
 * Browser login import, through the existing dialog and nothing else. The
 * action is gated exactly as Settings ▸ General's import row is - a desktop
 * with a browser bridge, and saved logins ON - and when it cannot run the
 * card says why rather than hiding: the search result that lands here has
 * to land on something honest. The dialog mounts only after an enabled
 * click, so rendering the page never starts a scan.
 */
/** Why the import cannot run here, or `undefined` for the row's own copy. */
function loginImportExplanation(input: {
  readonly available: boolean;
  readonly hasBridge: boolean;
  readonly saveLoginsEnabled: boolean | null;
}): string | undefined {
  if (input.available) return undefined;
  if (!input.hasBridge) {
    return "Available in the desktop app, where the browser can keep logins.";
  }
  if (input.saveLoginsEnabled === false) {
    return "Turn on Saved logins under Settings ▸ General ▸ Browser first - the import writes the logins the browser keeps.";
  }
  return "Saved logins can't be read right now, so the import can't start.";
}

function LoginImportLessonCard(): ReactNode {
  const browserView = useRunnerHostOrNull()?.browserView ?? null;
  const saveLoginsEnabled = useBrowserSaveLoginsEnabled(browserView);
  const available = useLoginImportAvailable() && !isMobileApp();
  const [importOpen, setImportOpen] = useState(false);
  const explanation = loginImportExplanation({
    available,
    hasBridge: browserView !== null && !isMobileApp(),
    saveLoginsEnabled,
  });
  return (
    <>
      <LessonCard
        lessonId="login-import"
        row={ONBOARDING_LESSON_ROWS["login-import"]}
        labelStatus={undefined}
        status={explanation}
        expanded={null}
        expandedId="onboarding-demo-login-import"
        control={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!available}
            data-testid="onboarding-import-logins"
            onClick={() => {
              trackLessonOpened("login-import");
              setImportOpen(true);
            }}
          >
            Import logins
          </Button>
        }
      />
      {importOpen && browserView !== null ? (
        <ImportLoginsDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          browserView={browserView}
        />
      ) : null}
    </>
  );
}
