/**
 * The Home tab's surface: every task with something happening in it, whatever
 * wants the user first.
 *
 * ONE reading, and that is the decision this page most recently made. It used
 * to offer two - a flat list of everything, and the same activity grouped under
 * its tasks - behind an in-page switch. The flat one asked the reader to hold
 * four sections and a task column in their head, so it went, and with it the
 * separate prompt list: a task waiting on an approval appeared twice, once as a
 * prompt and once as a task, in two vocabularies with two counts. Now a task
 * appears once, in the section that says whether it is waiting on the user, and
 * everything under it hangs off the chat it belongs to.
 *
 * Sections are omitted when they hold nothing rather than rendered empty, so
 * the page shrinks to what is true right now, and the empty state only appears
 * when both are empty. Ordering is the model's - this file renders, it does not
 * sort.
 *
 * Live updates arrive as new model values on the same mounted tree: rows carry
 * stable keys (a prompt's feed id, a task's epic id, a background job's key),
 * so a store change repaints rows instead of remounting them, and the relative
 * timestamps subscribe to the app's shared 60s clock inside their own leaves
 * rather than holding a timer here.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  HomeFocusPromptRow,
  type HomeFocusRowActions,
} from "@/components/home-focus/home-focus-rows";
import {
  HomeFocusTaskGroups,
  type HomeFocusTaskDisclosure,
} from "@/components/home-focus/home-focus-task-groups";
import { useFocusActions } from "@/hooks/home-focus/use-focus-actions";
import { useFocusModel } from "@/hooks/home-focus/use-focus-model";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";
import {
  selectTaskGroups,
  selectTaskSections,
  type FocusTaskGroup,
} from "@/lib/home-focus/focus-task-groups";
import {
  focusPromptHostId,
  groupRowsByHost,
  resolveFocusHostId,
  splitTaskGroupByHost,
  type FocusTaskGroupHostSlice,
} from "@/lib/home-focus/focus-host-groups";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  useHomeHostGroups,
  type HomeHostGrouping,
} from "@/hooks/home-focus/use-home-host-groups";
import { HomeHostGroupedContext } from "@/components/home-focus/home-host-grouped-context";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { historyTabIntent } from "@/lib/tab-navigation/intents";
import type { FocusModel, FocusPromptRow } from "@/lib/home-focus/focus-model";

/**
 * The same window-local limit both sections carry, said the way a task list
 * needs it said.
 *
 * The heading covers every task, background or not, and the limit binds a PART
 * of each row - the `N bg` badge, the `N browsers` badge and the job and page
 * children - so the caption has to name what is bounded rather than appear to
 * bound the task list itself.
 */
const BACKGROUND_CAPTION = "Background shown for tasks open in this window";
/** Frozen so the Running section hands the same array identity every render
 * rather than a fresh one. */
const RUNNING_CAPTIONS: ReadonlyArray<string> = Object.freeze([
  BACKGROUND_CAPTION,
]);
const NOTIFICATIONS_LOCAL_CAPTION = "this host only";
// Deliberately does not name other hosts: `disconnected` is also what THIS
// client's own activity stream reports when it is closed, and then a section
// can be empty outright rather than merely partial.
const ACTIVITY_NOTICE = "Some activity may be missing";

/**
 * How many tasks may open at once on first entry.
 *
 * Above it every row is collapsed, because an expand-all on a busy account is a
 * page the user has to scroll before they can see how many tasks there even
 * are - and the count in each section heading already tells them. Counted over
 * the WHOLE page rather than per section: the reader scrolls one page, and a
 * rule applied twice would expand eight tasks whenever they happened to be
 * four and four.
 */
const EXPAND_ALL_MAX_TASKS = 3;

const SECTION_IDS = {
  needsYou: "home-focus-needs-you",
  running: "home-focus-running",
} as const;

interface HomeSummarySegment {
  readonly id: string;
  readonly count: number;
  readonly label: string;
  /** Rows behind this segment, paired with the host each belongs to, so the
   * tooltip can break the number down without the visible line doing it. */
  readonly perHost: ReadonlyArray<{
    readonly hostId: string | null;
  }>;
}

/**
 * `Laptop 2 · remote-box 1`, for a segment's tooltip.
 *
 * The breakdown lives in the tooltip and NOT in the line, and that is the
 * decision rather than an omission: the summary's whole job is to be read in
 * one glance, and a line that named machines would stop being one. `null` when
 * the page is not grouped by host, where the breakdown would just restate the
 * count.
 */
function summaryHostBreakdown(
  segment: HomeSummarySegment,
  grouping: HomeHostGrouping,
): string | null {
  if (!grouping.enabled) return null;
  const counts = new Map<string, number>();
  for (const row of segment.perHost) {
    const hostId = resolveFocusHostId(row.hostId, grouping.activeHostId);
    counts.set(hostId, (counts.get(hostId) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return groupRowsByHost(Array.from(counts.entries()), ([hostId]) => hostId, {
    activeHostId: grouping.activeHostId,
    registryOrder: grouping.registryOrder,
  })
    .flatMap((group) => group.rows)
    .map(([hostId, count]) => `${grouping.labelOf(hostId)} ${String(count)}`)
    .join(" · ");
}

/**
 * The whole page in one line, and the one line a user reads before deciding
 * whether to read the page.
 *
 * It names the two sections the page draws and counts exactly what they list at
 * their top level, so a segment can never promise a number the section under it
 * does not show. A zero segment is omitted rather than greyed - "0 running" is
 * a fact nobody came here for, and always-present segments would make the ones
 * that matter harder to find.
 *
 * Each segment is a real button that moves focus to its section rather than an
 * anchor that only scrolls: on a long Home the keyboard user is the one who
 * most needs to skip, and `scroll-mt-4` on the section keeps the heading clear
 * of the top edge when it lands.
 */
function HomeSummaryLine(props: {
  readonly sections: HomeSections;
  readonly grouping: HomeHostGrouping;
}): ReactNode {
  const { sections, grouping } = props;
  const segments: ReadonlyArray<HomeSummarySegment> = [
    {
      id: SECTION_IDS.needsYou,
      count: sectionCount(sections.needsYou),
      label: "need you",
      perHost: [
        ...sliceHosts(sections.needsYou.slices),
        ...sections.needsYou.prompts.map((row) => ({
          hostId: focusPromptHostId(row),
        })),
      ],
    },
    {
      id: SECTION_IDS.running,
      count: sectionCount(sections.running),
      label: "running",
      perHost: sliceHosts(sections.running.slices),
    },
  ].filter((segment) => segment.count > 0);
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
          <TooltipWrapper
            label={summaryHostBreakdown(segment, grouping)}
            side="bottom"
            sideOffset={undefined}
            align={undefined}
          >
            <button
              type="button"
              onClick={() => focusSection(segment.id)}
              className="rounded-sm px-1 py-0.5 outline-none hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              data-testid="home-focus-summary-segment"
              data-segment={segment.label}
              data-target={segment.id}
              data-hosts={summaryHostBreakdown(segment, grouping) ?? undefined}
            >
              {segment.count} {segment.label}
            </button>
          </TooltipWrapper>
        </span>
      ))}
    </div>
  );
}

function sliceHosts(
  slices: ReadonlyArray<FocusTaskGroupHostSlice>,
): ReadonlyArray<{ readonly hostId: string | null }> {
  return slices.map((slice) => ({ hostId: slice.hostId }));
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

/**
 * One section's rows as the page will draw them: the task slices, plus the
 * prompt rows that belong to no task at all.
 */
interface HomeSection {
  readonly slices: ReadonlyArray<FocusTaskGroupHostSlice>;
  readonly prompts: ReadonlyArray<FocusPromptRow>;
}

interface HomeSections {
  readonly needsYou: HomeSection;
  readonly running: HomeSection;
  /** Every task group on the page, before the host split - what the expand rule
   * counts and what decides whether there is anything to draw. */
  readonly groups: ReadonlyArray<FocusTaskGroup>;
}

/** A section's own number, which is what its heading and its summary segment
 * both read: the rows it lists at its top level. */
function sectionCount(section: HomeSection): number {
  return section.slices.length + section.prompts.length;
}

/** The React key AND the disclosure key for one machine's share of a task. Two
 * ids that cannot collide, joined on a byte neither can contain.
 *
 * Per HOST rather than per task, because a task worked from two machines is two
 * rows the reader opens independently - and safe as a disclosure key across a
 * section move, since prompts never open a host group of their own, so
 * answering a prompt cannot change which hosts a task is split across. */
function hostSliceKey(epicId: string, hostId: string): string {
  return [epicId, hostId].join("\u0000");
}

/**
 * Which task rows are open, held ABOVE the two sections.
 *
 * It has to live here rather than in the row, and the reason is the section
 * split: answering a task's last prompt moves it from `Needs you` to `Running`,
 * which unmounts its `<li>` from one subtree and mounts a new one in the other.
 * A key is only stable within one parent, so row-local state collapsed a task
 * the user had just opened, at the exact moment they had acted on it.
 *
 * Two pieces of state, and they answer different questions. `expandAll` is the
 * page's default, LATCHED on the first render that actually has tasks - not on
 * mount, because this component renders from the app's first frame, and the
 * notification feed can arrive before the activity plane: a page holding one
 * orphan prompt and no tasks would latch `0 <= 3` and then throw twenty tasks
 * open when they landed. `overrides` is the rows the user has since touched.
 *
 * Both are adjusted DURING render rather than from an effect, which is the
 * supported shape for state derived from props: React re-runs this component
 * immediately, before committing, so nothing paints twice, and both writes are
 * idempotent - the second pass finds the latch set and nothing stale to prune.
 */
const NO_OVERRIDES: ReadonlyMap<string, boolean> = new Map();

function useTaskDisclosure(
  sections: HomeSections,
  /** Every row key the page is about to draw. Anything else in `overrides` is a
   * task that has left the model, and its choice goes with it - so a task that
   * comes back comes back at the page's default, which is the self-pruning the
   * row-local state gave for free. */
  liveKeys: ReadonlySet<string>,
): HomeFocusTaskDisclosure {
  const [expandAll, setExpandAll] = useState<boolean | null>(null);
  const [overrides, setOverrides] =
    useState<ReadonlyMap<string, boolean>>(NO_OVERRIDES);
  const taskCount = sections.groups.length;
  if (expandAll === null && taskCount > 0) {
    setExpandAll(taskCount <= EXPAND_ALL_MAX_TASKS);
  }
  if (hasStaleKey(overrides, liveKeys)) {
    setOverrides(
      new Map(Array.from(overrides).filter(([key]) => liveKeys.has(key))),
    );
  }
  const fallback = expandAll ?? true;
  return {
    isExpanded: (key) => overrides.get(key) ?? fallback,
    toggle: (key) => {
      setOverrides((previous) => {
        const next = new Map(previous);
        next.set(key, !(previous.get(key) ?? fallback));
        return next;
      });
    },
  };
}

function hasStaleKey(
  overrides: ReadonlyMap<string, boolean>,
  liveKeys: ReadonlySet<string>,
): boolean {
  for (const key of overrides.keys()) {
    if (!liveKeys.has(key)) return true;
  }
  return false;
}

/** Every task row key the page is drawing, across both sections. */
function liveSliceKeys(sections: HomeSections): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const section of [sections.needsYou, sections.running]) {
    for (const slice of section.slices) {
      keys.add(hostSliceKey(slice.group.epicId, slice.hostId));
    }
  }
  return keys;
}

/**
 * Splits the model into the two sections and their host slices, and files every
 * prompt no slice ended up carrying.
 *
 * That last part is the honest half. A prompt reaches a task group by `epicId`,
 * and three things can leave one unplaced: an approval whose payload carried no
 * epic id (they are optional on the wire), an epic with a pending prompt and no
 * running agent, warm chat or open page to make a group out of, and the host
 * split, which files a prompt under the machine it was RAISED on and drops it
 * from the slices of machines that did not raise it. Home's tab badge counts
 * prompts, so a prompt the page cannot show is a badge reading `1` over a page
 * showing nothing. Listing what no slice took - computed FROM the slices rather
 * than from a second guess at the same rule - is what makes that impossible
 * instead of merely unlikely.
 */
function selectHomeSections(
  model: FocusModel,
  grouping: HomeHostGrouping,
): HomeSections {
  const groups = selectTaskGroups(model);
  const sections = selectTaskSections(groups);
  const splitOptions = {
    enabled: grouping.enabled,
    activeHostId: grouping.activeHostId,
  };
  const needsYouSlices = sections.needsYou.flatMap((group) =>
    splitTaskGroupByHost(group, splitOptions),
  );
  const runningSlices = sections.running.flatMap((group) =>
    splitTaskGroupByHost(group, splitOptions),
  );
  const placed = new Set<string>();
  for (const slice of [...needsYouSlices, ...runningSlices]) {
    for (const prompt of slice.group.prompts) placed.add(prompt.key);
  }
  return {
    needsYou: {
      slices: needsYouSlices,
      prompts: model.prompts.filter((prompt) => !placed.has(prompt.key)),
    },
    running: { slices: runningSlices, prompts: [] },
    groups,
  };
}

export function HomeFocusView(): ReactNode {
  const model = useFocusModel();
  const actions: HomeFocusRowActions = useFocusActions();
  const hostGrouping = useHomeHostGroups(model);
  const sections = useMemo(
    () => selectHomeSections(model, hostGrouping),
    [model, hostGrouping],
  );
  const liveKeys = useMemo(() => liveSliceKeys(sections), [sections]);
  // Above the empty branch, because it is above the SECTION split: a hook that
  // only ran while the page had rows would lose the latch and every open row
  // the moment the model briefly emptied.
  const disclosure = useTaskDisclosure(sections, liveKeys);
  const empty =
    sections.groups.length === 0 && sections.needsYou.prompts.length === 0;
  return (
    // One landmark for the whole page - the inner groups are plain containers
    // with `h2` headings so a screen reader gets a heading outline rather than
    // two more regions to step through.
    <section
      aria-label="Home"
      data-testid="home-focus-view"
      className="h-full w-full overflow-y-auto"
    >
      {/* `pb-safe-bottom-gutter`, not `pb-6`: the page scrolls to its own end,
          so the last row has to clear the home indicator on a phone and still
          keep a real gutter on a desktop where every inset is zero. */}
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pt-6 pb-safe-bottom-gutter">
        <HomeSummaryLine sections={sections} grouping={hostGrouping} />
        <ActivityCoverageNotice
          activity={model.coverage.activity}
          attributedPerHost={degradedHostsAreVisible(
            model,
            hostGrouping,
            sections,
          )}
        />
        {empty ? (
          <HomeFocusEmptyState />
        ) : (
          <HomeHostGroupedContext.Provider value={hostGrouping.enabled}>
            <HomeFocusSections
              model={model}
              sections={sections}
              actions={actions}
              grouping={hostGrouping}
              disclosure={disclosure}
            />
          </HomeHostGroupedContext.Provider>
        )}
      </div>
    </section>
  );
}

/**
 * The two sections, in order. They share one disclosure store, owned above
 * them, because a task moving between them must not lose the row the user just
 * opened - see {@link useTaskDisclosure}.
 */
function HomeFocusSections(props: {
  readonly model: FocusModel;
  readonly sections: HomeSections;
  readonly actions: HomeFocusRowActions;
  readonly grouping: HomeHostGrouping;
  readonly disclosure: HomeFocusTaskDisclosure;
}): ReactNode {
  const { model, sections, actions, grouping, disclosure } = props;
  return (
    <>
      <HomeTaskSection
        title="Needs you"
        id={SECTION_IDS.needsYou}
        testId="home-focus-section-needs-you"
        section={sections.needsYou}
        // The feed's reach is stated HERE and nowhere else: it bounds which
        // tasks can be in this section at all, and the section below it is not
        // built from notifications.
        captions={
          model.coverage.notifications === "local"
            ? [NOTIFICATIONS_LOCAL_CAPTION, BACKGROUND_CAPTION]
            : [BACKGROUND_CAPTION]
        }
        actions={actions}
        grouping={grouping}
        degradedHostIds={model.coverage.degradedHostIds}
        disclosure={disclosure}
      />
      <HomeTaskSection
        title="Running"
        id={SECTION_IDS.running}
        testId="home-focus-section-running"
        section={sections.running}
        captions={RUNNING_CAPTIONS}
        actions={actions}
        grouping={grouping}
        degradedHostIds={model.coverage.degradedHostIds}
        disclosure={disclosure}
      />
    </>
  );
}

/**
 * The machines this page draws a LABELLED host group for - which is exactly the
 * set that can carry a coverage notice, because `hostRowGroups` puts the notice
 * on a group's subheading and nowhere else.
 *
 * Read off the rendered slices rather than off the model, and that is the whole
 * point. Asking the model which hosts are "visible" answers a similar-sounding
 * question with a different set: a prompt's origin host counts as a visible
 * activity host there, but an UNPLACED prompt renders in the section's
 * unlabelled tail, which has no subheading and therefore no notice. A degraded
 * host present only as an orphan prompt then suppressed a banner that nothing
 * had replaced.
 */
function noticeBearingHostIds(sections: HomeSections): ReadonlySet<string> {
  const hostIds = new Set<string>();
  for (const section of [sections.needsYou, sections.running]) {
    for (const slice of section.slices) hostIds.add(slice.hostId);
  }
  return hostIds;
}

/**
 * Whether every degraded host has a group on this page to carry its notice.
 *
 * The page-wide banner stands down only when something downstream is saying the
 * same thing in a better place. A degraded host with NO group has no subheading
 * and therefore no notice, so suppressing the banner for it would drop the
 * warning entirely - and that host is exactly the one whose rows are missing
 * BECAUSE its stream is degraded, which is the case the notice exists for.
 *
 * Derived from what renders, so the two can never come apart: the banner stands
 * down if and only if every degraded host has a subheading that is saying the
 * sentence instead.
 */
function degradedHostsAreVisible(
  model: FocusModel,
  grouping: HomeHostGrouping,
  sections: HomeSections,
): boolean {
  if (!grouping.enabled) return false;
  const degraded = model.coverage.degradedHostIds;
  if (degraded.length === 0) return false;
  const visible = noticeBearingHostIds(sections);
  return degraded.every((hostId) => visible.has(hostId));
}

/**
 * Says the page may be incomplete, and only when it may be. `unknown` is not a
 * warning: it is what a client that has never heard from the activity plane
 * reports at startup, and a notice on every cold open would train the user to
 * ignore the one that matters.
 */
function ActivityCoverageNotice(props: {
  readonly activity: FocusModel["coverage"]["activity"];
  /**
   * True when the sections are naming their machines and at least one of them
   * is carrying this sentence already.
   *
   * The page-wide banner then stands down: saying "some activity may be
   * missing" over a page that says WHICH host it is missing from is strictly
   * less information in a louder place. It comes back the moment nothing
   * downstream can attribute the gap - an `unknown`-shaped verdict with no
   * degraded slice to pin it on, or a page with one host and no headings.
   */
  readonly attributedPerHost: boolean;
}): ReactNode {
  const degraded =
    !props.attributedPerHost &&
    (props.activity === "reconnecting" || props.activity === "disconnected");
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
 * Rows arrive as GROUPS, one per machine once the page names more than one.
 */
export interface HomeFocusRowGroup {
  readonly key: string;
  /** A subheading above this group's rows, or `null` for the single unlabelled
   * group a section renders when the page names one host. */
  readonly label: string | null;
  /** This group's own count, beside its subheading - the section keeps its
   * total, and the group says how much of it is here. `null` while unlabelled,
   * where the section's own heading has already said it. */
  readonly count: number | null;
  /** Marks the machine the user is working on, which leads the list. */
  readonly isActive: boolean;
  /** A coverage caveat that belongs to THIS host, not the page: the notice
   * moves under the heading it is about when only some hosts are degraded. */
  readonly notice: string | null;
  readonly rows: ReactNode;
}

function HomeFocusSection(props: {
  readonly title: string;
  readonly count: string;
  /** Each caveat on its OWN line. Two sentences joined by a separator would be
   * the same run-together defect the heading had, one level down - and the page
   * genuinely has two independent limits to state under Needs you: the
   * notification feed's reach, and the window-local background plane. */
  readonly captions: ReadonlyArray<string>;
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
        {props.captions.map((caption) => (
          <p key={caption} data-testid={`${props.testId}-caption`}>
            {caption}
          </p>
        ))}
      </div>
      {props.groups.map((group) =>
        // No wrapper for the unlabelled shape, so a single-host install's DOM
        // is unchanged by host grouping existing. A labelled group brings its
        // own box with it.
        group.label === null ? (
          <ul key={group.key} className="flex flex-col">
            {group.rows}
          </ul>
        ) : (
          <div key={group.key} className="flex flex-col">
            <div
              className="flex flex-col gap-0.5 px-3 pt-2 pb-1"
              data-testid={`${props.testId}-group`}
              data-host-id={group.key}
            >
              <div className="flex flex-wrap items-center gap-x-2 text-ui-xs text-muted-foreground">
                {/* `h3` under the section's `h2`: a reader stepping the heading
                    outline gets "Running · 3" then the machines under it,
                    which is the shape the page actually has. */}
                <h3
                  className="font-medium"
                  data-testid={`${props.testId}-group-label`}
                >
                  {group.label}
                  {group.count === null ? null : ` · ${String(group.count)}`}
                </h3>
                {group.isActive ? (
                  <span
                    className="rounded-sm bg-foreground/8 px-1.5 py-0.5"
                    data-testid={`${props.testId}-group-active`}
                  >
                    active
                  </span>
                ) : null}
              </div>
              {group.notice === null ? null : (
                <p
                  className="text-ui-xs text-muted-foreground"
                  data-testid={`${props.testId}-group-notice`}
                >
                  {group.notice}
                </p>
              )}
            </div>
            <ul className="flex flex-col">{group.rows}</ul>
          </div>
        ),
      )}
    </section>
  );
}

/**
 * A section's rows, split by machine when the page spans more than one.
 *
 * Falls back to one unlabelled group whenever grouping is off, so a section's
 * call site is the same shape either way and the single-host page keeps the
 * exact DOM it had before host grouping existed.
 *
 * The degraded-coverage notice moves HERE from the top of the page when only
 * some hosts are degraded: the sentence belongs to the machine that earned it,
 * and a page-wide banner over a page that names its machines is telling the
 * reader less than it knows.
 */
interface HomeHostRowGroup<Row> extends Omit<HomeFocusRowGroup, "rows"> {
  readonly items: ReadonlyArray<Row>;
}

function hostRowGroups<Row>(
  rows: ReadonlyArray<Row>,
  hostIdOf: (row: Row) => string | null,
  context: {
    readonly grouping: HomeHostGrouping;
    readonly degradedHostIds: ReadonlyArray<string>;
  },
): ReadonlyArray<HomeHostRowGroup<Row>> {
  const { grouping } = context;
  if (!grouping.enabled) {
    return [
      {
        key: "all",
        label: null,
        count: null,
        isActive: false,
        notice: null,
        items: rows,
      },
    ];
  }
  const degraded = new Set(context.degradedHostIds);
  return groupRowsByHost(rows, hostIdOf, {
    activeHostId: grouping.activeHostId,
    registryOrder: grouping.registryOrder,
  }).map((group) => ({
    key: group.hostId,
    label: grouping.labelOf(group.hostId),
    count: group.rows.length,
    isActive: group.hostId === grouping.activeHostId,
    notice: degraded.has(group.hostId) ? ACTIVITY_NOTICE : null,
    items: group.rows,
  }));
}

/**
 * One of the page's two task lists.
 *
 * The same component draws both, because they differ in exactly one thing -
 * which tasks are in them - and every other question (host grouping, the
 * background caveat, the disclosure default, what a row looks like) has the
 * same answer in each. Two components would have been two places to keep that
 * answer.
 *
 * The trailing prompt rows are the Needs you section's own tail: prompts no
 * task group could carry. They are LAST, under the tasks, because a row that
 * cannot say which task it belongs to is the least locatable thing here, and
 * they render outside the host groups because their own host is the one thing
 * about them that is usually known and never useful - there is no task there to
 * read them against.
 */
function HomeTaskSection(props: {
  readonly title: string;
  readonly id: string;
  readonly testId: string;
  readonly section: HomeSection;
  readonly captions: ReadonlyArray<string>;
  readonly actions: HomeFocusRowActions;
  readonly grouping: HomeHostGrouping;
  readonly degradedHostIds: ReadonlyArray<string>;
  readonly disclosure: HomeFocusTaskDisclosure;
}): ReactNode {
  const { section, actions, disclosure } = props;
  const count = sectionCount(section);
  if (count === 0) return null;
  const taskGroups = hostRowGroups(section.slices, (slice) => slice.hostId, {
    grouping: props.grouping,
    degradedHostIds: props.degradedHostIds,
  }).map(({ items, ...group }) => ({
    ...group,
    rows: (
      <HomeFocusTaskGroups
        // Per task: only a task drawn under more than one host names the
        // machine. A bucket-wide label made an A-only sibling of an A/B task
        // read `Stop all on A` for a stop that was never scoped.
        entries={items.map((slice) => ({
          key: hostSliceKey(slice.group.epicId, slice.hostId),
          group: slice.group,
          stopAllHostLabel: slice.splitAcrossHosts
            ? props.grouping.labelOf(slice.hostId)
            : null,
        }))}
        actions={actions}
        disclosure={disclosure}
      />
    ),
  }));
  const groups: ReadonlyArray<HomeFocusRowGroup> =
    section.prompts.length === 0
      ? taskGroups
      : [
          ...taskGroups,
          {
            key: "unplaced-prompts",
            label: null,
            count: null,
            isActive: false,
            notice: null,
            // `false`, ALWAYS, and never the page's grouping. The context means
            // "a host subheading above this row already names its machine", and
            // this group is the one that deliberately has none - so on a
            // multi-host page these rows would drop their origin chip and lose
            // the only host attribution they have.
            rows: (
              <HomeHostGroupedContext.Provider value={false}>
                {section.prompts.map((row) => (
                  <HomeFocusPromptRow
                    key={row.key}
                    row={row}
                    actions={actions}
                    showLocation
                  />
                ))}
              </HomeHostGroupedContext.Provider>
            ),
          },
        ];
  return (
    <HomeFocusSection
      title={props.title}
      count={String(count)}
      captions={props.captions}
      testId={props.testId}
      id={props.id}
      groups={groups}
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
