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
import {
  epicIdsWithJobs,
  focusCounts,
  runningTasks,
} from "@/lib/home-focus/focus-running";
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

/**
 * The anchors the summary line jumps to.
 *
 * `running` is one id across both views on purpose: Focus's `Running` and
 * Tasks's `Tasks` are the same band of the page answering the same question,
 * and only one of them is ever mounted, so a segment that means "take me to the
 * work" needs one target rather than a branch.
 */
const SECTION_IDS = {
  needsYou: "home-focus-needs-you",
  running: "home-focus-running",
  background: "home-focus-background",
} as const;

interface HomeSummarySegment {
  readonly id: string;
  readonly count: number;
  readonly label: string;
}

/**
 * The whole page in one line, and the one line a user reads before deciding
 * whether to read the page.
 *
 * **It names only sections the CURRENT VIEW renders**, which is why it takes
 * the view rather than just the model. Focus draws three sections and gets
 * three segments. Tasks draws two - the global Needs you, and one Tasks section
 * where running work and background work are grouped together - so it gets
 * `N need you · N tasks`, with the task count being the groups it actually
 * lists. A `background` segment there pointed at a region Tasks never mounts,
 * so the click found no element and did nothing at all; on a background-only
 * account it was the only button on the line and it was inert.
 *
 * Each segment is a real button that moves focus to its section rather than an
 * anchor that only scrolls: on a long Home the keyboard user is the one who
 * most needs to skip, and `scroll-mt-4` on the section keeps the heading clear
 * of the top edge when it lands.
 *
 * A zero segment is omitted rather than greyed - "0 background" is a fact
 * nobody came here for, and always-present segments would make the ones that
 * matter harder to find. Counts come from `focusCounts` and from the same
 * grouping the Tasks section renders, so a segment can never promise a section
 * that is not there.
 */
function HomeSummaryLine(props: {
  readonly view: HomeView;
  readonly model: FocusModel;
  readonly groups: ReadonlyArray<FocusTaskGroup>;
}): ReactNode {
  const counts = focusCounts(props.model);
  const segments: ReadonlyArray<HomeSummarySegment> = (
    props.view === "tasks"
      ? [
          {
            id: SECTION_IDS.needsYou,
            count: counts.needsYou,
            label: "need you",
          },
          {
            id: SECTION_IDS.running,
            count: props.groups.length,
            label: props.groups.length === 1 ? "task" : "tasks",
          },
        ]
      : [
          {
            id: SECTION_IDS.needsYou,
            count: counts.needsYou,
            label: "need you",
          },
          { id: SECTION_IDS.running, count: counts.running, label: "running" },
          {
            id: SECTION_IDS.background,
            count: counts.background,
            label: "background",
          },
        ]
  ).filter((segment) => segment.count > 0);
  if (segments.length === 0) return null;
  return (
    <div
      aria-label="Summary"
      role="group"
      data-testid="home-focus-summary"
      className="flex flex-wrap items-center gap-x-1 gap-y-1 px-3 text-ui-xs text-muted-foreground"
    >
      {segments.map((segment, index) => (
        <span key={segment.id} className="flex items-center gap-1">
          {index === 0 ? null : (
            <span aria-hidden className="text-muted-foreground/60">
              ·
            </span>
          )}
          <button
            type="button"
            onClick={() => focusSection(segment.id)}
            className="rounded-sm px-1 py-0.5 outline-none hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            data-testid="home-focus-summary-segment"
            data-segment={segment.label}
            data-target={segment.id}
          >
            {segment.count} {segment.label}
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * Moves the page to a section and puts focus on it.
 *
 * The section carries `tabIndex={-1}`, so focus lands on the region itself and
 * a screen reader reads its heading on arrival - which is the half a bare
 * scroll leaves out. `focus()` alone also scrolls, but not with the section's
 * own `scroll-mt`, so the explicit `scrollIntoView` runs first.
 */
function focusSection(id: string): void {
  const section = document.getElementById(id);
  if (section === null) return;
  section.scrollIntoView({ block: "start", behavior: "smooth" });
  section.focus({ preventScroll: true });
}

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
        <HomeSummaryLine view={view} model={model} groups={groups} />
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

/**
 * One band of rows under a heading.
 *
 * The heading is COUNT ONLY, and the caption is a block-level sibling under it
 * rather than a flex neighbour beside it. Both halves of that matter and the
 * second is what was wrong: the caption was already a separate `<p>`, but it
 * sat on the same baseline row as the `<h2>`, so the band rendered
 * `BACKGROUND · 1 Only tasks open in this window` and read as one sentence.
 * Its own line, at `text-ui-xs`, is what makes the count scannable and the
 * caveat still available.
 *
 * Rows arrive as GROUPS rather than as children. There is exactly one group
 * today, unlabelled, so the DOM is what it was - the seam exists because the
 * next change subdivides these sections by host, and a section that already
 * renders a list of groups takes that as a label appearing rather than as a
 * rewrite of every section on the page.
 */
export interface HomeFocusRowGroup {
  readonly key: string;
  /** A subheading above this group's rows, or `null` for the single unlabelled
   * group every section renders today. */
  readonly label: string | null;
  readonly rows: ReactNode;
}

function HomeFocusSection(props: {
  readonly title: string;
  readonly count: string;
  readonly caption: string | null;
  readonly testId: string;
  readonly id: string;
  readonly groups: ReadonlyArray<HomeFocusRowGroup>;
}): ReactNode {
  return (
    <section
      data-testid={props.testId}
      id={props.id}
      aria-labelledby={`${props.id}-heading`}
      tabIndex={-1}
      // `@container`: the rows' duration hides on a narrow ROW rather than a
      // narrow viewport, so a slim Home tile in a wide window behaves like the
      // slim thing it is.
      className="@container flex scroll-mt-4 flex-col gap-1 outline-none"
    >
      <div className="flex flex-col gap-0.5 px-3 pt-4 pb-1 text-ui-xs text-muted-foreground">
        <h2
          id={`${props.id}-heading`}
          className="tracking-[0.08em] uppercase"
          data-testid={`${props.testId}-heading`}
        >
          {props.title} · {props.count}
        </h2>
        {props.caption === null ? null : (
          <p data-testid={`${props.testId}-caption`}>{props.caption}</p>
        )}
      </div>
      {props.groups.map((group) =>
        // No wrapper for the unlabelled shape: today's single group has to
        // render byte-for-byte what the section rendered before the seam
        // existed, or "one group today, so the DOM is unchanged" is a claim
        // rather than a fact. A labelled group brings its own box with it.
        group.label === null ? (
          <ul key={group.key} className="flex flex-col">
            {group.rows}
          </ul>
        ) : (
          <div key={group.key} className="flex flex-col">
            <p
              className="px-3 pt-2 pb-1 text-ui-xs text-muted-foreground"
              data-testid={`${props.testId}-group-label`}
            >
              {group.label}
            </p>
            <ul className="flex flex-col">{group.rows}</ul>
          </div>
        ),
      )}
    </section>
  );
}

/** The single unlabelled group every section renders today. */
function oneRowGroup(rows: ReactNode): ReadonlyArray<HomeFocusRowGroup> {
  return [{ key: "all", label: null, rows }];
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
      id={SECTION_IDS.needsYou}
      groups={oneRowGroup(
        prompts.map((row) => (
          <HomeFocusPromptRow key={row.key} row={row} actions={props.actions} />
        )),
      )}
    />
  );
}

/**
 * Running is MID-TURN AGENTS ONLY, wherever Background can show the rest.
 *
 * A WARM task whose agents are all background-tier is not a Running row: its
 * work is a set of durable jobs, and those are listed once, in Background,
 * under their own names. Listing it here as well is what made the page show
 * `Running · Greeting and Introduction · background` and
 * `Background · 10min heartbeat · running 5h` about one monitor.
 *
 * A task this window has no job row for is the other case, and it keeps its
 * Running row: nothing in Background could stand in for it, so dropping it
 * would take the task off the page rather than de-duplicate it. That is the
 * cold background-only task, reading `background` beside H3's own
 * `n agents · not open in this window`.
 *
 * The heading counts this list rather than `model.tasks`, because a count that
 * included tasks the section does not draw is the same duplication in smaller
 * type.
 */
function TasksSection(props: {
  readonly model: FocusModel;
  readonly actions: HomeFocusRowActions;
}): ReactNode {
  const jobEpicIds = epicIdsWithJobs(props.model.background);
  const tasks = runningTasks(props.model.tasks, jobEpicIds);
  if (tasks.length === 0) return null;
  return (
    <HomeFocusSection
      title="Running"
      count={tasks.length === 1 ? "1 task" : `${tasks.length} tasks`}
      caption={null}
      testId="home-focus-section-tasks"
      id={SECTION_IDS.running}
      groups={oneRowGroup(
        tasks.map((row) => (
          <HomeFocusTaskRow
            key={row.epicId}
            row={row}
            actions={props.actions}
            hasVisibleJobs={jobEpicIds.has(row.epicId)}
          />
        )),
      )}
    />
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
      id={SECTION_IDS.running}
      groups={oneRowGroup(
        <HomeFocusTaskGroups groups={groups} actions={props.actions} />,
      )}
    />
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
      id={SECTION_IDS.background}
      groups={oneRowGroup(
        background.map((row) => (
          <HomeFocusBackgroundRow
            key={row.key}
            row={row}
            actions={props.actions}
          />
        )),
      )}
    />
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
