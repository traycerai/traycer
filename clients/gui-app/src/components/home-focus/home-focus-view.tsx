/**
 * The Home tab's surface: everything happening across every task on the host,
 * with whatever wants the user first.
 *
 * Sections are omitted when they hold nothing rather than rendered empty, so
 * the page shrinks to what is true right now, and the empty state only appears
 * when all three are empty. Ordering is the model's - this file renders, it
 * does not sort.
 *
 * Live updates arrive as new model values on the same mounted tree: rows carry
 * stable keys (a prompt's feed id, a task's epic id, a background job's key),
 * so a store change repaints rows instead of remounting them, and the relative
 * timestamps subscribe to the app's shared 60s clock inside their own leaves
 * rather than holding a timer here.
 */
import { useMemo, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  SettingsSegmentedControl,
  type SettingsSegmentedOption,
} from "@/components/settings/controls/settings-segmented-control";
import {
  HomeFocusBackgroundRow,
  HomeFocusPromptRow,
  HomeFocusTaskRow,
  type HomeFocusRowActions,
} from "@/components/home-focus/home-focus-rows";
import { HomeFocusTaskGroups } from "@/components/home-focus/home-focus-task-groups";
import { useFocusActions } from "@/hooks/home-focus/use-focus-actions";
import { useFocusModel } from "@/hooks/home-focus/use-focus-model";
import { trackSettingChanged } from "@/lib/analytics";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";
import {
  selectTaskGroups,
  type FocusTaskGroup,
} from "@/lib/home-focus/focus-task-groups";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { historyTabIntent } from "@/lib/tab-navigation/intents";
import { useLayoutStore, type HomeView } from "@/stores/settings/layout-store";
import type { FocusModel } from "@/lib/home-focus/focus-model";

const BACKGROUND_CAPTION = "Only tasks open in this window";
/**
 * The same window-local limit, said the way the Tasks section needs it said.
 *
 * Focus's caption sits on a section that IS the background list, so "only tasks
 * open in this window" scopes the rows under it. Under Tasks the heading covers
 * every task, background or not, and the limit binds a PART of each row - the
 * `N bg` badge and the job children - so the caption has to name what is
 * bounded rather than appear to bound the task list itself.
 */
const TASKS_BACKGROUND_CAPTION =
  "Background shown for tasks open in this window";
const NOTIFICATIONS_LOCAL_CAPTION = "this host only";
// Deliberately does not name other hosts: `disconnected` is also what THIS
// client's own activity stream reports when it is closed, and then the Running
// section can be empty outright rather than merely partial.
const ACTIVITY_NOTICE = "Some activity may be missing";

const HOME_VIEW_OPTIONS: ReadonlyArray<SettingsSegmentedOption<HomeView>> = [
  { value: "focus", label: "Focus" },
  { value: "tasks", label: "Tasks" },
];

/** What Focus hands `viewIsEmpty` and `HomeFocusSections` in place of a
 * grouping neither of them reads. */
const NO_TASK_GROUPS: ReadonlyArray<FocusTaskGroup> = Object.freeze([]);

export function HomeFocusView(): ReactNode {
  const model = useFocusModel();
  const actions: HomeFocusRowActions = useFocusActions();
  const view = useLayoutStore((state) => state.home.view);
  const setHomeView = useLayoutStore((state) => state.setHomeView);
  // Grouped only for the view that renders groups. Focus reads its emptiness
  // off the model alone (`viewIsEmpty`) and draws none of these rows, so on the
  // default view this is a pass over prompts and background rows that nothing
  // consumes. The frozen empty array keeps the identity stable across Focus
  // renders rather than handing consumers a fresh `[]` each time.
  const groups = useMemo(
    () => (view === "tasks" ? selectTaskGroups(model) : NO_TASK_GROUPS),
    [model, view],
  );
  return (
    // One landmark for the whole page - the inner groups are plain containers
    // with `h2` headings so a screen reader gets a heading outline rather than
    // three more regions to step through.
    <section
      aria-label="Home"
      data-testid="home-focus-view"
      data-view={view}
      className="h-full w-full overflow-y-auto"
    >
      {/* `pb-safe-bottom-gutter`, not `pb-6`: the page scrolls to its own end,
          so the last row has to clear the home indicator on a phone and still
          keep a real gutter on a desktop where every inset is zero. */}
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pt-6 pb-safe-bottom-gutter">
        {/* A control row rather than a title bar. Home's name is already on the
            tab that opened it, so repeating it here would cost the first
            section a line of vertical space and say nothing - the one thing
            this row adds is the choice, and it is right-aligned so the page
            still starts, visually, with Needs you. */}
        <div className="flex items-center justify-end px-3">
          <SettingsSegmentedControl
            value={view}
            options={HOME_VIEW_OPTIONS}
            onChange={(next) => {
              trackSettingChanged("layout", "layout.home.view");
              setHomeView(next);
            }}
            ariaLabel="Home view"
          />
        </div>
        <ActivityCoverageNotice activity={model.coverage.activity} />
        {viewIsEmpty(view, model, groups) ? (
          <HomeFocusEmptyState />
        ) : (
          <HomeFocusSections
            view={view}
            model={model}
            groups={groups}
            actions={actions}
          />
        )}
      </div>
    </section>
  );
}

/**
 * Whether the CHOSEN VIEW has anything to draw - which is not the same question
 * as whether the model is empty, and the difference is a blank page.
 *
 * The two views render different projections of the same model, so "nothing to
 * show" has to be asked of the projection. Tasks draws prompts and groups and
 * has no Background section, so a model whose only content is background work
 * would pass a model-level emptiness check, suppress the empty state, and then
 * render both of its sections as `null`: a page with a segmented control and
 * nothing under it, saying neither what is running nor that anything is hidden.
 *
 * `selectTaskGroups` keeps the gap from being wide - it groups background-only
 * epics too, so Tasks is genuinely empty far less often than it would be on an
 * intersection - but "far less often" is not "never", and the empty state is
 * the honest thing to draw when it is.
 *
 * `groups` is READ ON THE TASKS BRANCH ONLY, and that is a requirement rather
 * than an accident: the caller does not compute a grouping for Focus, so under
 * Focus the argument is an empty array that says nothing about the model.
 * Focus's own answer comes off the model, exactly as it did before either view
 * existed.
 */
function viewIsEmpty(
  view: HomeView,
  model: FocusModel,
  groups: ReadonlyArray<FocusTaskGroup>,
): boolean {
  if (model.prompts.length > 0) return false;
  if (view === "tasks") return groups.length === 0;
  return model.tasks.length === 0 && model.background.length === 0;
}

/**
 * What each view lists, and in what order.
 *
 * `Needs you` is FIRST AND GLOBAL in both, deliberately: the two views disagree
 * about how running work is arranged, never about where the things waiting on
 * the user live. Tasks has no Background section of its own - a job is listed
 * under the task it belongs to, including when that task has nothing running
 * and is on the page for its background work alone.
 */
function HomeFocusSections(props: {
  readonly view: HomeView;
  readonly model: FocusModel;
  readonly groups: ReadonlyArray<FocusTaskGroup>;
  readonly actions: HomeFocusRowActions;
}): ReactNode {
  const { model, actions } = props;
  if (props.view === "tasks") {
    return (
      <>
        <PromptsSection model={model} actions={actions} />
        <TaskGroupsSection groups={props.groups} actions={actions} />
      </>
    );
  }
  return (
    <>
      <PromptsSection model={model} actions={actions} />
      <TasksSection model={model} actions={actions} />
      <BackgroundSection model={model} actions={actions} />
    </>
  );
}

/**
 * Says the page may be incomplete, and only when it may be. `unknown` is not a
 * warning: it is what a client that has never heard from the activity plane
 * reports at startup, and a notice on every cold open would train the user to
 * ignore the one that matters.
 */
function ActivityCoverageNotice(props: {
  readonly activity: FocusModel["coverage"]["activity"];
}): ReactNode {
  const degraded =
    props.activity === "reconnecting" || props.activity === "disconnected";
  // The live region is mounted whether or not it has anything to say: a region
  // inserted together with its first content is announced far less reliably
  // than one already in the tree when the text appears. `display: contents`
  // keeps that permanence free of layout - an empty box would otherwise take a
  // slot in the page's `gap-2` column and push the first section down.
  return (
    <div role="status" aria-live="polite" className="contents">
      {degraded ? (
        <p
          data-testid="home-focus-activity-notice"
          data-activity={props.activity}
          className="rounded-md bg-foreground/5 px-3 py-2 text-ui-xs text-muted-foreground"
        >
          {ACTIVITY_NOTICE}
        </p>
      ) : null}
    </div>
  );
}

function HomeFocusSection(props: {
  readonly title: string;
  readonly count: string;
  readonly caption: string | null;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div data-testid={props.testId} className="flex flex-col gap-1">
      {/* The caption is a SIBLING of the heading, not inside it: a screen
          reader's heading outline should read "Background · 2", not
          "Background · 2 Only tasks open in this window". */}
      <div className="flex flex-wrap items-baseline gap-x-2 px-3 pt-4 pb-1 text-ui-xs text-muted-foreground">
        <h2 className="tracking-[0.08em] uppercase">
          {props.title} · {props.count}
        </h2>
        {props.caption === null ? null : (
          <p data-testid={`${props.testId}-caption`}>{props.caption}</p>
        )}
      </div>
      <ul className="flex flex-col">{props.children}</ul>
    </div>
  );
}

function PromptsSection(props: {
  readonly model: FocusModel;
  readonly actions: HomeFocusRowActions;
}): ReactNode {
  const { prompts } = props.model;
  if (prompts.length === 0) return null;
  return (
    <HomeFocusSection
      title="Needs you"
      count={String(prompts.length)}
      caption={
        props.model.coverage.notifications === "local"
          ? NOTIFICATIONS_LOCAL_CAPTION
          : null
      }
      testId="home-focus-section-prompts"
    >
      {prompts.map((row) => (
        <HomeFocusPromptRow key={row.key} row={row} actions={props.actions} />
      ))}
    </HomeFocusSection>
  );
}

function TasksSection(props: {
  readonly model: FocusModel;
  readonly actions: HomeFocusRowActions;
}): ReactNode {
  const { tasks } = props.model;
  if (tasks.length === 0) return null;
  return (
    <HomeFocusSection
      title="Running"
      count={tasks.length === 1 ? "1 task" : `${tasks.length} tasks`}
      caption={null}
      testId="home-focus-section-tasks"
    >
      {tasks.map((row) => (
        <HomeFocusTaskRow key={row.epicId} row={row} actions={props.actions} />
      ))}
    </HomeFocusSection>
  );
}

/**
 * The Tasks view's regrouping of Running and Background.
 *
 * There is no separate Background section under this view: a job belongs to the
 * task it runs in, and listing it twice would be the same row under two
 * headings. That only holds because `selectTaskGroups` groups on the UNION of
 * task epics and job epics - a task with a durable shell and no running agent
 * is a group of its own rather than a row with nowhere to go.
 *
 * It carries a Background caption of its own, because this section makes the
 * same window-local claim the Background section does and is the only place a
 * reader can now see it stated. Every `N bg` badge and every job child under it
 * is bounded by that sentence - and only those: the task list itself is not
 * window-local, which is why the wording is not Focus's.
 */
function TaskGroupsSection(props: {
  readonly groups: ReadonlyArray<FocusTaskGroup>;
  readonly actions: HomeFocusRowActions;
}): ReactNode {
  const { groups } = props;
  if (groups.length === 0) return null;
  return (
    <HomeFocusSection
      title="Tasks"
      count={groups.length === 1 ? "1 task" : `${groups.length} tasks`}
      caption={TASKS_BACKGROUND_CAPTION}
      testId="home-focus-section-task-groups"
    >
      <HomeFocusTaskGroups groups={groups} actions={props.actions} />
    </HomeFocusSection>
  );
}

function BackgroundSection(props: {
  readonly model: FocusModel;
  readonly actions: HomeFocusRowActions;
}): ReactNode {
  const { background } = props.model;
  if (background.length === 0) return null;
  return (
    <HomeFocusSection
      title="Background"
      count={String(background.length)}
      caption={BACKGROUND_CAPTION}
      testId="home-focus-section-background"
    >
      {background.map((row) => (
        <HomeFocusBackgroundRow
          key={row.key}
          row={row}
          actions={props.actions}
        />
      ))}
    </HomeFocusSection>
  );
}

/**
 * Nothing is running and nothing is pending. Home has no composer (that is
 * Start New's job), so the two ways out are links to the two surfaces that do
 * have one.
 */
function HomeFocusEmptyState(): ReactNode {
  const navigate = useNavigate();
  return (
    <div
      data-testid="home-focus-empty"
      className="flex flex-col items-center justify-center gap-2 py-[min(4rem,12vh)] text-center text-ui-sm text-muted-foreground"
    >
      <p className="font-medium text-foreground">Nothing needs you.</p>
      <p>Start a new task or open a recent one.</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={() => {
            navigateToTabIntent(navigate, openNewEpicIntent(), undefined);
          }}
          data-testid="home-focus-empty-new-task"
        >
          Start a new task
        </Button>
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={() => {
            navigateToTabIntent(navigate, historyTabIntent(), undefined);
          }}
          data-testid="home-focus-empty-history"
        >
          Open History
        </Button>
      </div>
    </div>
  );
}
