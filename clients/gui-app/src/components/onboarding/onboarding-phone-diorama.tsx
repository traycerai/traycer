import { useEffect, useState } from "react";
import { m, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  FileText,
  Files,
  GitBranch,
  LogOut,
  Menu,
  MessagesSquare,
  Settings,
  SquareArrowOutUpRight,
  SquareStack,
  Terminal,
  TriangleAlert,
  UserCircle,
  type LucideIcon,
} from "lucide-react";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { EASE, TASKS } from "@/components/onboarding/onboarding-diorama-shared";
import {
  PANE_LABEL,
  STORY_STEPS,
  useStoryStep,
  type MeshAgentId,
  type StoryBeat,
  type StoryKind,
} from "@/components/onboarding/onboarding-story-script";
import { cn } from "@/lib/utils";

/**
 * The phone miniature for the mobile tour, drawn to the same treatment as the
 * desktop diorama (`onboarding-diorama.tsx`) — semantic theme tokens only, so
 * it follows the user's live theme, the same layered drop shadow, and the same
 * motion grammar (opacity fades on `EASE`, interval cycling, `useReducedMotion`
 * pinning every scene to its settled end state).
 *
 * It teaches the two affordances a phone user must find and the desktop tour
 * never mentions (the hamburger drawer and the top-right switcher sheet), the
 * gestures that move between screens, and it replays the shared agent story
 * (`onboarding-story-script.ts`) down a single column.
 */
interface OnboardingPhoneDioramaProps {
  readonly scene: OnboardingPhoneSceneId;
}

/** What this phone miniature can draw. */
export type OnboardingPhoneSceneId =
  | "drawer"
  | "switcher"
  | "story"
  | "gestures";

/** Which mini-header glyph the scene spotlights. */
type HeaderGlyphId = "menu" | "switcher" | "bell";

/** How long the panel waits before it slides in, so the frame reads first. */
const REVEAL_DELAY_MS = 700;
/** Active-row / active-category cadence, matching the desktop tab cycle. */
const CYCLE_MS = 1900;

/**
 * The frame is container-led: its height is whatever the page's grid row
 * hands down (`h-full`, capped by the tour's `--onboarding-diorama-max-height`
 * budget), and the 9/19 aspect derives the width from it. `max-w-full` lets a
 * narrow column clamp the width instead - `aspect-ratio` transfers that cap
 * back into the height, so the frame letterboxes and never distorts or runs
 * past the actions bar below its row.
 */
const PHONE_FRAME_CLASS =
  "@container relative flex aspect-[9/19] h-full max-h-[var(--onboarding-diorama-max-height)] max-w-full flex-col overflow-hidden rounded-3xl border border-white/12 bg-background text-foreground shadow-[0_2rem_4rem_-1.75rem_rgba(0,0,0,0.72),0_0.875rem_2rem_-1.25rem_rgba(0,0,0,0.55)] transition-colors duration-500";

/** Recency labels for the drawer's task rows, keyed so a rename breaks here. */
const RECENT_TASK_AGES: Readonly<Record<(typeof TASKS)[number], string>> = {
  "Team usage limits": "2m",
  "Billing service": "1h",
  "Usage sync audit": "3d",
};

/**
 * Older history below the three live tasks. A real drawer is never three rows
 * and a void; these keep the miniature's composition honest without joining
 * the active-row cycle (they read as settled work, slightly dimmed).
 */
const OLDER_DRAWER_TASKS = [
  ["Provider pack audit", "1w"],
  ["Release notes draft", "2w"],
] as const satisfies ReadonlyArray<readonly [string, string]>;

interface SwitcherCategory {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly rows: ReadonlyArray<string>;
}

/**
 * The four categories the act's copy names, with the real MOBILE switcher bar's
 * titles and icons in its own relative order — the sheet teaches a bar the user
 * is about to see, so it must not fork the copy. "Chats" rather than the
 * desktop rail's "Agents": the phone bar overrides that one label
 * (`MOBILE_SWITCHER_TITLE_OVERRIDES`) so the tab names what it lists.
 */
const SWITCHER_CATEGORIES = [
  {
    label: "Chats",
    icon: MessagesSquare,
    rows: ["Team usage limits", "Grace-period plan", "API path audit"],
  },
  {
    label: "Artifacts",
    icon: Files,
    rows: ["usage-limits.spec", "Grace-period rollout", "Risk review"],
  },
  {
    label: "Git Diff",
    icon: GitBranch,
    rows: ["billing-service/limits.ts", "api/usage-route.ts", "sync/worker.ts"],
  },
  {
    label: "Terminals",
    icon: Terminal,
    rows: ["billing-service run", "verification run", "risk review run"],
  },
] as const satisfies ReadonlyArray<SwitcherCategory>;

export function OnboardingPhoneDiorama(props: OnboardingPhoneDioramaProps) {
  const { scene } = props;
  const reducedMotion = useReducedMotion() === true;
  return (
    <div className="relative mx-auto flex h-full min-h-0 w-full justify-center">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-[10%] bg-[radial-gradient(closest-side,rgba(255,255,255,0.07),transparent_72%)]"
      />
      <div
        data-testid="onboarding-phone-diorama"
        data-scene={scene}
        className={PHONE_FRAME_CLASS}
      >
        <PhoneScene scene={scene} reducedMotion={reducedMotion} />
      </div>
    </div>
  );
}

/**
 * The story and gesture scenes own the whole screen; the nav scenes raise a
 * panel over the shared task tile.
 */
function PhoneScene(props: {
  readonly scene: OnboardingPhoneSceneId;
  readonly reducedMotion: boolean;
}) {
  const { scene, reducedMotion } = props;
  if (scene === "story") {
    return <StoryChatScene reducedMotion={reducedMotion} />;
  }
  if (scene === "gestures") {
    return <GestureScene reducedMotion={reducedMotion} />;
  }
  return (
    <>
      {/* The panels cover the header exactly as the real overlays do. The
          lesson still has its cause: the control sits spotlit through the
          opening beat and a touch cue lands on it right before the panel
          arrives, so what opened it is shown, not guessed. */}
      <PhoneHeader
        title={TASKS[0]}
        spotlight={scene === "drawer" ? "menu" : "switcher"}
      />
      <PhoneTaskScreen className="min-h-0 flex-1" />
      {scene === "drawer" ? (
        <NavDrawerScene reducedMotion={reducedMotion} />
      ) : (
        <SwitcherSheetScene reducedMotion={reducedMotion} />
      )}
    </>
  );
}

/**
 * Mirrors `MobileAppHeader`'s composition: hamburger, surface title, then the
 * right cluster of global controls with the switcher trigger ahead of the bell.
 */
function PhoneHeader(props: {
  readonly title: string;
  readonly spotlight: HeaderGlyphId | null;
}) {
  return (
    <header className="relative flex h-9 shrink-0 items-center gap-1 bg-background px-2 text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-border/90 after:content-['']">
      <HeaderGlyph id="menu" icon={Menu} spotlit={props.spotlight === "menu"} />
      {/* On a frame too small to fit a legible title, the glyphs carry the
          header alone - a title truncated to two letters teaches nothing. The
          outer span stays as the flexible spacer either way. */}
      <span className="min-w-0 flex-1 truncate text-ui-xs font-medium text-foreground">
        <span className="hidden @min-[11rem]:inline">{props.title}</span>
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        <HeaderGlyph
          id="switcher"
          icon={SquareStack}
          spotlit={props.spotlight === "switcher"}
        />
        <HeaderGlyph id="bell" icon={Bell} spotlit={false} />
      </div>
    </header>
  );
}

/**
 * A header control. The spotlight reuses the desktop diorama's grammar — a
 * primary hairline ring plus a soft primary bloom, cross-faded over 500ms.
 */
function HeaderGlyph(props: {
  readonly id: HeaderGlyphId;
  readonly icon: LucideIcon;
  readonly spotlit: boolean;
}) {
  const Icon = props.icon;
  return (
    <span
      aria-hidden="true"
      data-testid="onboarding-phone-header-glyph"
      data-glyph={props.id}
      data-spotlit={props.spotlit ? "true" : "false"}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md transition-[color,box-shadow,background-color] duration-500",
        props.spotlit
          ? "bg-primary/10 text-primary shadow-[0_0_0_1px_hsl(var(--primary)/0.32),0_0_1.5rem_-0.75rem_hsl(var(--primary)/0.85)]"
          : "text-muted-foreground/70",
      )}
    >
      <Icon className="size-3.5" />
    </span>
  );
}

/**
 * The single full-screen tile a phone shows: one chat, one composer. The nav
 * scenes stretch it under their overlays; the gesture scene parks it in a
 * horizontal track, so the caller owns its sizing.
 */
function PhoneTaskScreen(props: { readonly className: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("flex flex-col overflow-hidden bg-canvas", props.className)}
    >
      <div className="flex min-h-0 flex-1 flex-col justify-end gap-1.5 p-2.5">
        <div className="ml-auto max-w-[88%] rounded-lg rounded-br-sm bg-primary px-2 py-1 text-ui-xs text-primary-foreground">
          Let&apos;s ship team usage limits.
        </div>
        <div className="mr-auto flex w-[82%] flex-col gap-1 rounded-lg rounded-bl-sm bg-foreground/6 px-2 py-1.5">
          <span className="h-1 w-full rounded-full bg-foreground/15" />
          <span className="h-1 w-4/5 rounded-full bg-foreground/15" />
          <span className="h-1 w-3/5 rounded-full bg-foreground/15" />
        </div>
      </div>
      <div className="shrink-0 border-t border-border p-2">
        <div className="h-7 rounded-md border border-border bg-background" />
      </div>
    </div>
  );
}

/**
 * The finger that summons a panel: a touch cue lands on the spotlit control
 * just before the panel opens, so the panel reads as an effect with a shown
 * cause. Plays once on mount and ends invisible, under the arriving panel.
 */
function PanelTapCue(props: { readonly control: HeaderGlyphId }) {
  return (
    <m.span
      aria-hidden="true"
      initial={{ opacity: 0, scale: 0.5 }}
      animate={{ opacity: [0, 1, 1, 0], scale: [0.5, 1, 0.85, 1.35] }}
      transition={{
        duration: 0.6,
        ease: EASE,
        times: [0, 0.3, 0.7, 1],
        delay: 0.08,
      }}
      className={cn(
        "pointer-events-none absolute top-[0.5rem] z-10 size-5 rounded-full bg-primary/25 ring-2 ring-primary/60",
        props.control === "menu" ? "left-[0.65rem]" : "right-[2.25rem]",
      )}
    />
  );
}

function NavDrawerScene(props: { readonly reducedMotion: boolean }) {
  const { reducedMotion } = props;
  const revealed = useRevealed(reducedMotion);
  const activeIndex = useCyclingIndex(TASKS.length, reducedMotion);
  return (
    <>
      {reducedMotion ? null : <PanelTapCue control="menu" />}
      <PhoneScrim revealed={revealed} reducedMotion={reducedMotion} />
      <m.aside
        data-testid="onboarding-phone-drawer"
        data-open={revealed ? "true" : "false"}
        initial={reducedMotion ? false : { opacity: 0, x: "-100%" }}
        animate={{ opacity: revealed ? 1 : 0, x: revealed ? "0%" : "-100%" }}
        transition={{ duration: 0.42, ease: EASE }}
        className="absolute inset-y-0 left-0 z-30 flex w-[80%] flex-col overflow-hidden border-r border-border bg-popover text-popover-foreground shadow-2xl"
      >
        <div className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-1.5">
          <UserCircle className="size-6 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-ui-xs font-medium text-foreground">
              Your account
            </span>
            <span className="truncate text-overline text-muted-foreground">
              Subscription
            </span>
          </div>
          <SquareArrowOutUpRight className="size-3.5 shrink-0 text-muted-foreground/70" />
          <LogOut className="size-3.5 shrink-0 text-muted-foreground/70" />
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-1 p-2">
          {/* The drawer's one filled element, matching `MobileNavDrawer`: the
              create action reads as a pill beside flat history rows. */}
          <span className="flex h-7 shrink-0 items-center justify-center rounded-md bg-primary px-3 text-ui-xs font-semibold text-primary-foreground">
            New task
          </span>
          <div className="flex shrink-0 items-center justify-between px-1 pt-1">
            <span className="text-overline uppercase tracking-wider text-muted-foreground">
              Recent tasks
            </span>
            <span className="text-overline text-muted-foreground/70">
              View all
            </span>
          </div>
          {TASKS.map((task, index) => (
            <DrawerTaskRow
              key={task}
              label={task}
              age={RECENT_TASK_AGES[task]}
              active={index === activeIndex}
            />
          ))}
          <div className="flex flex-col gap-1 opacity-55">
            {OLDER_DRAWER_TASKS.map(([task, age]) => (
              <DrawerTaskRow key={task} label={task} age={age} active={false} />
            ))}
          </div>
        </nav>
        <div className="shrink-0 border-t border-border/60 p-2">
          <div className="flex h-7 items-center gap-2 rounded-md px-2 text-ui-xs text-foreground/75">
            <Settings className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">Settings</span>
          </div>
        </div>
      </m.aside>
    </>
  );
}

function DrawerTaskRow(props: {
  readonly label: string;
  readonly age: string;
  readonly active: boolean;
}) {
  return (
    <div
      data-testid="onboarding-phone-drawer-task"
      data-active={props.active ? "true" : "false"}
      className={cn(
        "flex h-7 min-w-0 shrink-0 items-center gap-2 rounded-md px-2 text-ui-xs transition-colors duration-300",
        props.active
          ? "bg-accent text-accent-foreground"
          : "text-foreground/75",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      <span className="shrink-0 text-overline text-muted-foreground">
        {props.age}
      </span>
    </div>
  );
}

function SwitcherSheetScene(props: { readonly reducedMotion: boolean }) {
  const { reducedMotion } = props;
  const revealed = useRevealed(reducedMotion);
  const activeIndex = useCyclingIndex(
    SWITCHER_CATEGORIES.length,
    reducedMotion,
  );
  const category = SWITCHER_CATEGORIES[activeIndex];
  const RowIcon = category.icon;
  return (
    <>
      {reducedMotion ? null : <PanelTapCue control="switcher" />}
      <PhoneScrim revealed={revealed} reducedMotion={reducedMotion} />
      <m.div
        data-testid="onboarding-phone-sheet"
        data-open={revealed ? "true" : "false"}
        initial={reducedMotion ? false : { opacity: 0, y: "100%" }}
        animate={{ opacity: revealed ? 1 : 0, y: revealed ? "0%" : "100%" }}
        transition={{ duration: 0.42, ease: EASE }}
        className="absolute inset-x-0 bottom-0 z-30 flex h-[64%] flex-col overflow-hidden rounded-t-2xl border-t border-border bg-popover text-popover-foreground shadow-2xl"
      >
        <span
          aria-hidden="true"
          className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-foreground/20"
        />
        <div className="mt-2 flex shrink-0 items-stretch border-b border-border/70 px-2">
          {SWITCHER_CATEGORIES.map((entry, index) => (
            <SwitcherTab
              key={entry.label}
              label={entry.label}
              active={index === activeIndex}
            />
          ))}
        </div>
        {/* Keyed on the category so the body cross-fades on every beat rather
            than swapping its rows in place. */}
        <m.div
          key={category.label}
          initial={reducedMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, ease: EASE }}
          className="flex min-h-0 flex-1 flex-col gap-1 p-2"
        >
          {category.rows.map((row) => (
            <div
              key={row}
              data-testid="onboarding-phone-sheet-row"
              className="flex h-7 min-w-0 shrink-0 items-center gap-2 rounded-md px-2 text-ui-xs text-foreground/75"
            >
              <RowIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{row}</span>
            </div>
          ))}
        </m.div>
      </m.div>
    </>
  );
}

/** Line-variant tab, matching `SwitcherCategoryTabs`. Text only: four labels
 *  share a phone's width, and an icon per tab costs the label its room. */
function SwitcherTab(props: {
  readonly label: string;
  readonly active: boolean;
}) {
  return (
    <span
      data-testid="onboarding-phone-switcher-tab"
      data-active={props.active ? "true" : "false"}
      className={cn(
        "flex min-w-0 flex-1 items-center justify-center border-b-2 px-1 pb-1.5 text-overline uppercase tracking-wider transition-colors duration-300",
        props.active
          ? "border-b-primary text-foreground"
          : "border-b-transparent text-muted-foreground/70",
      )}
    >
      <span className="truncate">{props.label}</span>
    </span>
  );
}

/** Dims the whole screen, header included, the way the real overlays do. */
function PhoneScrim(props: {
  readonly revealed: boolean;
  readonly reducedMotion: boolean;
}) {
  return (
    <m.div
      aria-hidden="true"
      initial={props.reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: props.revealed ? 1 : 0 }}
      transition={{ duration: 0.32, ease: EASE }}
      className="absolute inset-0 z-20 bg-black/45 supports-backdrop-filter:backdrop-blur-xs"
    />
  );
}

/**
 * The agent story, one column deep. The desktop plays the same script across
 * three panes; a phone has one, so Codex's beats stay chat bubbles and the two
 * terminal agents fold into the same column as compact lines and pills. Every
 * beat, label and cadence comes from `onboarding-story-script.ts` — the two
 * platforms tell one story.
 */
function StoryChatScene(props: { readonly reducedMotion: boolean }) {
  const { reducedMotion } = props;
  // Mounted only while this scene is on screen, so the script always runs.
  const step = useStoryStep(true, reducedMotion);
  return (
    <>
      <PhoneHeader title={TASKS[0]} spotlight={null} />
      <div
        aria-hidden="true"
        className="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas"
      >
        {/* Bottom-anchored: the column overflows past a handful of beats, and
            the latest one is the one worth seeing. */}
        <div className="flex min-h-0 flex-1 flex-col justify-end gap-1.5 overflow-hidden p-2.5">
          {STORY_STEPS.slice(0, step + 1).map((beat) => (
            <StoryBeatRow
              key={beat.text}
              beat={beat}
              reducedMotion={reducedMotion}
            />
          ))}
        </div>
        <div className="shrink-0 border-t border-border p-2">
          <div className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-1.5">
            <span className="flex shrink-0 items-center gap-1 rounded bg-foreground/6 px-1 py-0.5 text-overline text-foreground/80">
              <HarnessIcon harnessId="codex" className="size-3" />
              Codex
            </span>
            <span className="min-w-0 flex-1 truncate text-code-xs text-muted-foreground/60">
              Ask anything…
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

/** One beat: a Codex bubble, a terminal tick, or a folded-in agent pill. */
function StoryBeatRow(props: {
  readonly beat: StoryBeat;
  readonly reducedMotion: boolean;
}) {
  const { beat, reducedMotion } = props;
  if (beat.pane === "gui") {
    return (
      <StoryGuiBubble
        kind={beat.kind}
        text={beat.text}
        to={beat.to}
        reducedMotion={reducedMotion}
      />
    );
  }
  if (beat.kind === "term" || beat.kind === "blocked") {
    return (
      <StoryAgentTick
        pane={beat.pane}
        kind={beat.kind}
        text={beat.text}
        reducedMotion={reducedMotion}
      />
    );
  }
  return (
    <StoryAgentPill
      pane={beat.pane}
      text={beat.text}
      to={beat.to}
      reducedMotion={reducedMotion}
    />
  );
}

/**
 * Codex's own beats, in the desktop `GuiMessage` grammar: the human right and
 * solid, an outgoing handoff right with a "to <agent>" kicker, a spec chip, and
 * everything received left. The one departure is the received fill — the
 * desktop bubble takes a `muted-fill-ok` waiver because its pane is literally
 * `bg-canvas`; a phone screen is not guaranteed to be, so it uses the
 * sanctioned foreground alpha instead.
 */
function StoryGuiBubble(props: {
  readonly kind: StoryKind;
  readonly text: string;
  readonly to: MeshAgentId | null;
  readonly reducedMotion: boolean;
}) {
  const initial = props.reducedMotion ? false : { opacity: 0 };
  const transition = { duration: 0.3, ease: EASE };
  if (props.kind === "user") {
    return (
      <m.div
        data-testid="onboarding-phone-story-beat"
        data-pane="gui"
        initial={initial}
        animate={{ opacity: 1 }}
        transition={transition}
        className="ml-auto max-w-[88%] rounded-lg rounded-br-sm bg-primary px-2 py-1 text-ui-xs text-primary-foreground"
      >
        {props.text}
      </m.div>
    );
  }
  if (props.kind === "handoff" && props.to !== null) {
    return (
      <m.div
        data-testid="onboarding-phone-story-beat"
        data-pane="gui"
        initial={initial}
        animate={{ opacity: 1 }}
        transition={transition}
        className="ml-auto flex max-w-[92%] flex-col gap-0.5 rounded-lg rounded-br-sm bg-primary/10 px-2 py-1 text-ui-xs"
      >
        <span className="flex items-center gap-1 text-overline uppercase tracking-wider text-primary">
          <ArrowRight className="size-3 shrink-0" />
          to {PANE_LABEL[props.to]}
        </span>
        <span className="text-foreground/85">{props.text}</span>
      </m.div>
    );
  }
  if (props.kind === "spec") {
    return (
      <m.div
        data-testid="onboarding-phone-story-beat"
        data-pane="gui"
        initial={initial}
        animate={{ opacity: 1 }}
        transition={transition}
        className="mr-auto flex items-center gap-1.5 rounded-md bg-foreground/6 px-1.5 py-0.5 text-code-xs text-muted-foreground"
      >
        <FileText className="size-3 shrink-0 text-[var(--term-ansi-yellow)]" />
        {props.text}
      </m.div>
    );
  }
  const isDecision = props.kind === "decision";
  return (
    <m.div
      data-testid="onboarding-phone-story-beat"
      data-pane="gui"
      initial={initial}
      animate={{ opacity: 1 }}
      transition={transition}
      className="mr-auto flex max-w-[92%] flex-col gap-0.5 rounded-lg rounded-bl-sm bg-foreground/6 px-2 py-1 text-ui-xs"
    >
      <span className="flex items-center gap-1 text-overline uppercase tracking-wider text-muted-foreground">
        {isDecision ? (
          <>
            <Check className="size-3 shrink-0 text-[var(--term-ansi-green)]" />
            Decision
          </>
        ) : (
          <>
            <HarnessIcon harnessId="codex" className="size-3" />
            Codex
          </>
        )}
      </span>
      <span className="text-foreground/85">{props.text}</span>
    </m.div>
  );
}

/**
 * A terminal agent's own progress — the beats the desktop draws inside a TUI
 * body. With no pane to put them in, they read as thin ticks in the column:
 * green for work done, yellow for the beat that blocks the run.
 */
function StoryAgentTick(props: {
  readonly pane: "claude" | "opencode";
  readonly kind: "term" | "blocked";
  readonly text: string;
  readonly reducedMotion: boolean;
}) {
  const blocked = props.kind === "blocked";
  // Colour lives in the status glyph alone; the line itself stays muted so a
  // run of consecutive ticks reads as one quiet ledger, not competing alerts.
  return (
    <m.p
      data-testid="onboarding-phone-story-beat"
      data-pane={props.pane}
      initial={props.reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25, ease: EASE }}
      className="mr-auto flex max-w-[92%] items-center gap-1.5 pl-1 text-code-xs leading-snug text-muted-foreground"
    >
      {blocked ? (
        <TriangleAlert className="size-3 shrink-0 text-[var(--term-ansi-yellow)]" />
      ) : (
        <Check className="size-3 shrink-0 text-[var(--term-ansi-green)]" />
      )}
      <span className="min-w-0">{props.text}</span>
    </m.p>
  );
}

/**
 * A terminal agent speaking to another agent: the folded-in handoff pill.
 * Deliberately the same quiet fill as every other received bubble - the
 * harness icon and name kicker identify the speaker, so the bubble itself
 * carries no accent border or colour of its own.
 */
function StoryAgentPill(props: {
  readonly pane: "claude" | "opencode";
  readonly text: string;
  readonly to: MeshAgentId | null;
  readonly reducedMotion: boolean;
}) {
  return (
    <m.div
      data-testid="onboarding-phone-story-beat"
      data-pane={props.pane}
      initial={props.reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3, ease: EASE }}
      className="mr-auto flex max-w-[92%] flex-col gap-0.5 rounded-lg rounded-bl-sm bg-foreground/6 px-2 py-1 text-ui-xs"
    >
      <span className="flex items-center gap-1 text-overline uppercase tracking-wider text-muted-foreground">
        <HarnessIcon harnessId={props.pane} className="size-3" />
        {PANE_LABEL[props.pane]}
        {props.to !== null ? (
          <span className="flex items-center gap-0.5 text-foreground/60">
            <ArrowRight className="size-3 shrink-0" />
            {PANE_LABEL[props.to]}
          </span>
        ) : null}
      </span>
      <span className="text-foreground/85">{props.text}</span>
    </m.div>
  );
}

/** Which bezel a swipe starts from. */
type GestureEdge = "left" | "right";

interface GestureBeat {
  readonly edge: GestureEdge | null;
  /** Which page of the two-page track the screen rests on after this beat. */
  readonly page: 0 | 1;
  readonly ms: number;
}

/**
 * The looped lesson: sit on the task, swipe back from the left bezel to the
 * list behind it, sit there, swipe forward from the right bezel to return.
 */
const GESTURE_BEATS = [
  { edge: null, page: 1, ms: 900 },
  { edge: "left", page: 0, ms: 1700 },
  { edge: null, page: 0, ms: 900 },
  { edge: "right", page: 1, ms: 1700 },
] as const satisfies ReadonlyArray<GestureBeat>;

/** How long the touch dot takes to cross, well inside a swipe beat. */
const GESTURE_SWEEP_SECONDS = 1.35;

function GestureScene(props: { readonly reducedMotion: boolean }) {
  const { reducedMotion } = props;
  const beatIndex = useGestureBeat(reducedMotion);
  const beat = GESTURE_BEATS[beatIndex];
  // Reduced motion rests on the task screen and states both gestures instead.
  const page = reducedMotion ? 1 : beat.page;
  const edge = reducedMotion ? null : beat.edge;
  return (
    <>
      <PhoneHeader title={page === 0 ? "Tasks" : TASKS[0]} spotlight={null} />
      <div
        data-testid="onboarding-phone-gestures"
        data-edge={edge ?? "none"}
        data-page={String(page)}
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas"
      >
        {/* Two screens on one track: the swipe drags the track, which is what
            an edge swipe does to the app. No fake chrome, just the content. */}
        <m.div
          initial={reducedMotion ? false : { x: "-100%" }}
          animate={{ x: page === 0 ? "0%" : "-100%" }}
          transition={{ duration: 0.62, ease: EASE }}
          className="flex min-h-0 w-full flex-1"
        >
          <GestureTaskListPage />
          <PhoneTaskScreen className="w-full min-h-0 shrink-0" />
        </m.div>
        {reducedMotion ? (
          <GestureStaticHints />
        ) : (
          <>
            <GestureEdgeGlow edge={edge} />
            {edge !== null ? (
              <>
                <GestureTouch beatIndex={beatIndex} edge={edge} />
                <GestureCaption beatIndex={beatIndex} edge={edge} />
              </>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

/** The screen behind the task: where "back" lands. */
function GestureTaskListPage() {
  return (
    <div
      aria-hidden="true"
      className="flex w-full min-h-0 shrink-0 flex-col gap-1.5 overflow-hidden bg-canvas p-2.5"
    >
      {TASKS.map((task) => (
        <div
          key={task}
          className="flex h-8 shrink-0 items-center gap-2 rounded-lg border border-border/70 bg-foreground/3 px-2 text-ui-xs text-foreground/80"
        >
          <span className="min-w-0 flex-1 truncate">{task}</span>
          <span className="shrink-0 text-overline text-muted-foreground">
            {RECENT_TASK_AGES[task]}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The bezel lighting up under the finger. */
function GestureEdgeGlow(props: { readonly edge: GestureEdge | null }) {
  return (
    <>
      {(["left", "right"] as const).map((edge) => (
        <m.span
          key={edge}
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: props.edge === edge ? 1 : 0 }}
          transition={{ duration: 0.3, ease: EASE }}
          className={cn(
            "pointer-events-none absolute inset-y-0 z-10 w-[18%]",
            edge === "left"
              ? "left-0 bg-[linear-gradient(to_right,hsl(var(--primary)/0.3),transparent)]"
              : "right-0 bg-[linear-gradient(to_left,hsl(var(--primary)/0.3),transparent)]",
          )}
        />
      ))}
    </>
  );
}

/** The touch itself: in from the bezel, across, gone. Keyed per beat so each
 *  swipe replays from its own edge. */
function GestureTouch(props: {
  readonly beatIndex: number;
  readonly edge: GestureEdge;
}) {
  const from = props.edge === "left" ? "4%" : "96%";
  const to = props.edge === "left" ? "58%" : "42%";
  return (
    <m.span
      key={props.beatIndex}
      aria-hidden="true"
      data-testid="onboarding-phone-gesture-touch"
      initial={{ left: from, opacity: 0, scale: 0.6 }}
      animate={{
        left: [from, from, to, to],
        opacity: [0, 1, 1, 0],
        scale: [0.6, 1, 1, 0.82],
      }}
      transition={{
        duration: GESTURE_SWEEP_SECONDS,
        ease: EASE,
        times: [0, 0.14, 0.8, 1],
      }}
      className="pointer-events-none absolute top-1/2 z-20 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/25 ring-2 ring-primary/60 shadow-[0_0_1.5rem_-0.25rem_hsl(var(--primary)/0.8)]"
    />
  );
}

/** Names the gesture as it happens, so the motion is not a guess. */
function GestureCaption(props: {
  readonly beatIndex: number;
  readonly edge: GestureEdge;
}) {
  const isBack = props.edge === "left";
  return (
    <m.div
      key={props.beatIndex}
      aria-hidden="true"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: [0, 1, 1, 0], y: [6, 0, 0, 0] }}
      transition={{
        duration: GESTURE_SWEEP_SECONDS,
        ease: EASE,
        times: [0, 0.16, 0.78, 1],
      }}
      className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center"
    >
      <span
        data-testid="onboarding-phone-gesture-caption"
        className="flex items-center gap-1 rounded-full border border-border bg-popover px-2 py-0.5 text-overline uppercase tracking-wider text-foreground/80 shadow-lg"
      >
        {isBack ? (
          <>
            <ArrowLeft className="size-3 shrink-0 text-primary" />
            Back
          </>
        ) : (
          <>
            Forward
            <ArrowRight className="size-3 shrink-0 text-primary" />
          </>
        )}
      </span>
    </m.div>
  );
}

/** Reduced motion: no sweep to watch, so both edges state their gesture. */
function GestureStaticHints() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-between"
    >
      <GestureStaticHint edge="left" />
      <GestureStaticHint edge="right" />
    </div>
  );
}

function GestureStaticHint(props: { readonly edge: GestureEdge }) {
  const isBack = props.edge === "left";
  return (
    <span
      data-testid="onboarding-phone-gesture-hint"
      data-edge={props.edge}
      className={cn(
        "flex h-[22%] items-center gap-1 border-y border-primary/25 bg-primary/10 px-1.5 text-overline uppercase tracking-wider text-primary",
        isBack ? "rounded-r-full" : "flex-row-reverse rounded-l-full",
      )}
    >
      {isBack ? (
        <ArrowLeft className="size-3.5 shrink-0" />
      ) : (
        <ArrowRight className="size-3.5 shrink-0" />
      )}
      {isBack ? "Back" : "Forward"}
    </span>
  );
}

/** The gesture script's current beat, advancing on its own per-beat hold. */
function useGestureBeat(reducedMotion: boolean): number {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (reducedMotion) return;
    const id = window.setTimeout(
      () => setIndex((current) => (current + 1) % GESTURE_BEATS.length),
      GESTURE_BEATS[index].ms,
    );
    return () => window.clearTimeout(id);
  }, [reducedMotion, index]);
  return reducedMotion ? 0 : index;
}

/**
 * Whether the scene's panel has arrived. Reduced motion starts settled — the
 * drawer open, the sheet up — so the frame never animates and never sits on a
 * pre-reveal state the user would read as the finished picture.
 */
function useRevealed(reducedMotion: boolean): boolean {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (reducedMotion) return;
    const id = window.setTimeout(() => setRevealed(true), REVEAL_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [reducedMotion]);
  return reducedMotion || revealed;
}

/** The active row / category, advancing on a fixed cadence. */
function useCyclingIndex(count: number, reducedMotion: boolean): number {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (reducedMotion) return;
    const id = window.setInterval(
      () => setIndex((current) => (current + 1) % count),
      CYCLE_MS,
    );
    return () => window.clearInterval(id);
  }, [reducedMotion, count]);
  return reducedMotion ? 0 : index;
}
