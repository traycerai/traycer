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
import { type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  HomeFocusBackgroundRow,
  HomeFocusPromptRow,
  HomeFocusTaskRow,
  type HomeFocusRowActions,
} from "@/components/home-focus/home-focus-rows";
import { useFocusActions } from "@/hooks/home-focus/use-focus-actions";
import { useFocusModel } from "@/hooks/home-focus/use-focus-model";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { historyTabIntent } from "@/lib/tab-navigation/intents";
import type { FocusModel } from "@/lib/home-focus/focus-model";

const BACKGROUND_CAPTION = "Only tasks open in this window";
const NOTIFICATIONS_LOCAL_CAPTION = "this host only";
// Deliberately does not name other hosts: `disconnected` is also what THIS
// client's own activity stream reports when it is closed, and then the Running
// section can be empty outright rather than merely partial.
const ACTIVITY_NOTICE = "Some activity may be missing";

export function HomeFocusView(): ReactNode {
  const model = useFocusModel();
  const actions: HomeFocusRowActions = useFocusActions();
  const isEmpty =
    model.prompts.length === 0 &&
    model.tasks.length === 0 &&
    model.background.length === 0;
  return (
    // One landmark for the whole page - the inner groups are plain containers
    // with `h2` headings so a screen reader gets a heading outline rather than
    // three more regions to step through.
    <section
      aria-label="Home"
      data-testid="home-focus-view"
      className="h-full w-full overflow-y-auto"
    >
      {/* `pb-safe-bottom-gutter`, not `pb-6`: the page scrolls to its own end,
          so the last row has to clear the home indicator on a phone and still
          keep a real gutter on a desktop where every inset is zero. */}
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pt-6 pb-safe-bottom-gutter">
        <ActivityCoverageNotice activity={model.coverage.activity} />
        {isEmpty ? (
          <HomeFocusEmptyState />
        ) : (
          <>
            <PromptsSection model={model} actions={actions} />
            <TasksSection model={model} actions={actions} />
            <BackgroundSection model={model} actions={actions} />
          </>
        )}
      </div>
    </section>
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
