import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { m, useReducedMotion } from "motion/react";
import {
  Bell,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Folder,
  GitBranch,
  History,
  MessageSquare,
  Monitor,
  Pause,
  Play,
  Plus,
  SplitSquareHorizontal,
  Terminal,
  UserCircle,
  X,
  type LucideIcon,
} from "lucide-react";
import type { GuiHarnessId } from "@traycer/protocol/host/agent/shared";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  EASE,
  NAV_DROP_AGENTS,
  NAVIGATION_PHASE_MS,
  NEXT_NAVIGATION_PHASE,
  NODE_META,
  OPENCODE_RUN_LABEL,
  SIDEBAR_PANEL_RAIL_ITEMS,
  TASK_TAB_CYCLE_MS,
  TASKS,
  taskSceneFor,
  type NavigationPhase,
  type NodeKind,
  type TaskScene,
} from "@/components/settings/panels/onboarding/lesson-diorama-shared";

/** The two desktop lessons the miniature can play. */
export type LessonDioramaScene = "split-screen" | "task-tabs";

interface LessonDioramaProps {
  readonly scene: LessonDioramaScene;
}

type SpotlightRegion = "task-tabs" | "sidebar" | "main-pane" | "terminal-pane";

const CAPTION: Readonly<Record<LessonDioramaScene, string>> = {
  "split-screen":
    "Drag an agent from the sidebar to the right edge of the canvas to open it beside your chat, then drop another one below it to stack the split.",
  "task-tabs":
    "Every tab at the top is a task. Switching tabs swaps the whole workspace — the sidebar's agents and artifacts and the open canvas follow the task.",
};

/**
 * A looping miniature of the app that plays one desktop lesson: agents
 * dragged into a split, or the task tabs cycling. Mounted inline by an
 * expanded lesson card in Settings ▸ Onboarding.
 *
 * The miniature is a picture, not a surface: it is `inert` and `aria-hidden`
 * for the reason the Layout previews are (`layout/context-usage-preview.tsx`)
 * — every row, tab and pane inside it looks like a control that would be a
 * dead end here. What a screen reader and the tab order get instead is the
 * caption, which teaches the same action in words, and the pause control,
 * which is the one thing about the demo that is genuinely interactive. Both
 * sit OUTSIDE the inert frame.
 *
 * It reaches nothing real: no host, no tab store, no terminal runtime. The
 * cycle is local state driven by local timers, cleared on unmount, on pause,
 * and whenever the scene or the motion preference changes — `key={scene}`
 * remounts the player so a scene switch can never inherit a stale tick.
 *
 * Reduced motion is the settled frame with nothing scheduled: task 0 for the
 * tabs lesson, the finished two-pane split for the other. No cycle timers, no
 * drag pill, no pane entry fade, and no CSS colour/grid transitions either —
 * the timer half alone would leave the grid sliding open on mount. The
 * preference is read LIVE (`useLiveReducedMotion`), so flipping it while the
 * demo is open settles the frame at once rather than at the next mount.
 */
export function LessonDiorama(props: LessonDioramaProps) {
  const reducedMotion = useLiveReducedMotion();
  return (
    <LessonDioramaPlayer
      key={props.scene}
      scene={props.scene}
      reducedMotion={reducedMotion}
    />
  );
}

/**
 * `prefers-reduced-motion`, live. Motion's `useReducedMotion` is the first
 * read only — it is `useState(prefersReducedMotion.current)` with no setter,
 * and its own media listener updates a module ref that never re-renders — so
 * a demo left open while the OS setting changes would keep its timers and
 * drag motion. This keeps that initial read (it is what the rest of the app's
 * motion decides by) and subscribes to the media query for the changes.
 */
function useLiveReducedMotion(): boolean {
  const initial = useReducedMotion() === true;
  const [reduced, setReduced] = useState(initial);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = (event: MediaQueryListEvent): void => {
      setReduced(event.matches);
    };
    query.addEventListener("change", apply);
    return () => {
      query.removeEventListener("change", apply);
    };
  }, []);
  return reduced;
}

function LessonDioramaPlayer(props: {
  readonly scene: LessonDioramaScene;
  readonly reducedMotion: boolean;
}) {
  const { scene, reducedMotion } = props;
  const [paused, setPaused] = useState(false);
  const [taskIndex, setTaskIndex] = useState(0);
  const [phase, setPhase] = useState<NavigationPhase>("single");
  const dragLayerRef = useRef<HTMLDivElement>(null);
  const running = !paused && !reducedMotion;

  useEffect(() => {
    if (scene !== "task-tabs" || !running) return;
    const id = window.setInterval(
      () => setTaskIndex((index) => (index + 1) % TASKS.length),
      TASK_TAB_CYCLE_MS,
    );
    return () => window.clearInterval(id);
  }, [scene, running]);

  useEffect(() => {
    if (scene !== "split-screen" || !running) return;
    const id = window.setTimeout(
      () => setPhase((current) => NEXT_NAVIGATION_PHASE[current]),
      NAVIGATION_PHASE_MS[phase],
    );
    return () => window.clearTimeout(id);
  }, [scene, running, phase]);

  // The settled frame under reduced motion is DERIVED, not stored: the
  // preference can flip while a cycle is mid-way, and deriving it means the
  // very next render shows task 0 / the finished split with nothing to wait
  // for. The stored state is reset alongside so that, if the preference flips
  // back, the loop starts over from its first beat rather than from wherever
  // it was interrupted - during render, off the previous value, so the reset
  // lands in the same commit as the flip rather than one effect later.
  const [wasReducedMotion, setWasReducedMotion] = useState(reducedMotion);
  if (reducedMotion !== wasReducedMotion) {
    setWasReducedMotion(reducedMotion);
    if (reducedMotion) {
      setTaskIndex(0);
      setPhase("single");
    }
  }
  const activeTaskIndex =
    scene === "task-tabs" && !reducedMotion ? taskIndex : 0;
  const taskScene = taskSceneFor(activeTaskIndex);
  const navigationPhase: NavigationPhase =
    scene === "split-screen" && reducedMotion ? "split-2" : phase;
  const animate = !reducedMotion;

  return (
    <div className="w-full max-w-full space-y-3">
      <div
        inert
        aria-hidden
        data-testid="lesson-diorama-frame"
        data-scene={scene}
        data-phase={scene === "split-screen" ? navigationPhase : undefined}
        data-reduced-motion={reducedMotion ? "" : undefined}
        className={cn(
          "relative flex aspect-[16/10] w-full max-w-full flex-col overflow-hidden rounded-lg border border-border/70 bg-background text-foreground",
          animate && "transition-colors duration-500",
        )}
      >
        <MiniAppHeader activeIndex={activeTaskIndex} animate={animate} />
        <div
          ref={dragLayerRef}
          className="relative min-h-0 flex-1 bg-background"
        >
          <div className="grid h-full min-h-0 overflow-hidden bg-background [--mini-sidebar-width:min(27%,12rem)] [grid-template-columns:var(--mini-sidebar-width)_minmax(0,1fr)] [grid-template-rows:2.5rem_minmax(0,1fr)]">
            <WorkbenchPanelRail
              animate={animate}
              className={spotlightClass(scene, "sidebar", animate)}
            />
            <CanvasTopRail
              className={spotlightClass(scene, "main-pane", animate)}
            />
            <TaskSidebar
              taskScene={taskScene}
              activeKind={activeKindFor(scene)}
              animate={animate}
              className={spotlightClass(scene, "sidebar", animate)}
            />
            <CanvasWorkbench
              scene={scene}
              animate={animate}
              activeTaskIndex={activeTaskIndex}
              taskScene={taskScene}
              navigationPhase={navigationPhase}
            />
          </div>
          {scene === "split-screen" && animate ? (
            <NavigationDragDemo
              phase={navigationPhase}
              paused={paused}
              layerRef={dragLayerRef}
            />
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <p
          data-testid="lesson-diorama-caption"
          className="min-w-0 max-w-[72ch] flex-1 basis-[24ch] text-pretty text-ui-sm text-muted-foreground"
        >
          {CAPTION[scene]}
        </p>
        {/* Under reduced motion there is no cycle to pause: the frame is a
            still, and a control that could never change anything is noise. */}
        {reducedMotion ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPaused((current) => !current)}
            className="shrink-0"
          >
            {paused ? (
              <Play data-icon="inline-start" />
            ) : (
              <Pause data-icon="inline-start" />
            )}
            {paused ? "Play demo" : "Pause demo"}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The drag beat: a drop zone lighting up and the agent's pill travelling from
 * its sidebar row to it. Both run on Motion's own clock, which the phase
 * timers do not own, so `paused` has to reach them too: paused mid-drag, the
 * beat becomes a STILL — zone lit, pill parked on its row — rather than a
 * pill that finishes its journey under a "Play demo" label. Play restarts the
 * beat from its first frame (the keys change, and the phase timer restarts
 * with the phase's full duration), so the still is the drag "about to
 * happen", which is what it looks like.
 */
function NavigationDragDemo(props: {
  readonly phase: NavigationPhase;
  readonly paused: boolean;
  readonly layerRef: { readonly current: HTMLDivElement | null };
}) {
  const { phase, paused, layerRef } = props;
  const dragging = phase === "drag-1" || phase === "drag-2";
  const second = phase === "drag-2";
  const agent = second ? NAV_DROP_AGENTS[1] : NAV_DROP_AGENTS[0];
  // Start the drag from the agent's real position in the sidebar list, not a
  // guessed offset, by measuring its row against the drag layer.
  const [start, setStart] = useState<{
    readonly left: string;
    readonly top: string;
  } | null>(null);
  useLayoutEffect(() => {
    if (!dragging) return;
    const layer = layerRef.current;
    if (layer === null) return;
    const row = layer.querySelector(`[data-drag-harness="${agent.harnessId}"]`);
    if (row === null) return;
    const layerRect = layer.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (layerRect.width === 0 || layerRect.height === 0) return;
    setStart({
      left: `${((rowRect.left - layerRect.left + 14) / layerRect.width) * 100}%`,
      top: `${((rowRect.top - layerRect.top + rowRect.height / 2) / layerRect.height) * 100}%`,
    });
  }, [dragging, agent.harnessId, layerRef]);

  if (!dragging) return null;
  // Drop zone: first drag opens the whole right; second splits its lower half.
  const zoneClass = second
    ? "left-[64%] top-[54%] h-[40%] w-[33%]"
    : "left-[64%] top-[14%] h-[80%] w-[33%]";
  const zoneLabel = second ? "Drop to split below" : "Drop to split right";
  const endTop = second ? "73%" : "40%";
  const startLeft = start === null ? "7.5%" : start.left;
  const startTop = start === null ? agent.startTop : start.top;

  return (
    <>
      <m.div
        data-testid="lesson-diorama-drop-zone"
        data-paused={paused ? "" : undefined}
        key={`zone-${phase}-${paused}`}
        initial={paused ? false : { opacity: 0, scale: 0.98 }}
        animate={
          paused
            ? { opacity: 0.82, scale: 1 }
            : { opacity: [0, 0.55, 0.9, 0.82], scale: [0.98, 1, 1.02, 1] }
        }
        transition={{ duration: 1.1, ease: EASE, times: [0, 0.28, 0.72, 1] }}
        className={cn(
          "pointer-events-none absolute z-10 flex flex-col items-center justify-center rounded-md border border-dashed border-primary/55 bg-primary/10 text-center text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.1),0_0_2rem_-1rem_hsl(var(--primary)/0.85)]",
          zoneClass,
        )}
      >
        <div className="rounded border border-primary/35 bg-background/65 px-2 py-1 text-overline uppercase tracking-wider">
          {zoneLabel}
        </div>
        <div className="mt-2 text-code-xs text-primary/80">opens here</div>
      </m.div>
      <m.div
        data-testid="lesson-diorama-drag-pill"
        data-paused={paused ? "" : undefined}
        key={`pill-${phase}-${paused}-${startLeft}-${startTop}`}
        initial={
          paused
            ? false
            : { left: startLeft, top: startTop, opacity: 0, scale: 0.96 }
        }
        animate={
          paused
            ? { left: startLeft, top: startTop, opacity: 1, scale: 1 }
            : {
                left: [startLeft, startLeft, "78%", "78%"],
                top: [startTop, startTop, endTop, endTop],
                opacity: [0, 1, 1, 0],
                scale: [0.96, 1.03, 1, 0.98],
              }
        }
        transition={{ duration: 1.45, ease: EASE, times: [0, 0.18, 0.76, 1] }}
        className="pointer-events-none absolute z-30 flex w-[min(30%,12.5rem)] items-center gap-1.5 rounded-md border border-primary/45 bg-popover/95 px-2 py-1.5 text-code-xs text-popover-foreground shadow-xl backdrop-blur-sm"
      >
        <HarnessIcon
          harnessId={agent.harnessId}
          className="size-3.5 shrink-0"
        />
        <span className="truncate">{agent.label}</span>
      </m.div>
    </>
  );
}

function MiniAppHeader(props: {
  readonly activeIndex: number;
  readonly animate: boolean;
}) {
  return (
    <header className="relative flex h-10 shrink-0 items-center gap-2 bg-canvas px-3 text-canvas-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-border/90 after:content-['']">
      <div className="flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-[#ff5f57]" />
        <span className="size-2 rounded-full bg-[#ffbd2e]" />
        <span className="size-2 rounded-full bg-[#28c840]" />
      </div>
      <div className="ml-2 flex h-full min-w-0 flex-1 items-end self-stretch">
        <TaskTabs activeIndex={props.activeIndex} animate={props.animate} />
      </div>
      <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
        <Download className="size-3.5" />
        <History className="size-3.5" />
        <Bell className="size-3.5" />
        <UserCircle className="size-4" />
      </div>
    </header>
  );
}

function TaskTabs(props: {
  readonly activeIndex: number;
  readonly animate: boolean;
}) {
  const { activeIndex, animate } = props;
  return (
    <div className="flex h-full min-w-0 flex-1 items-end">
      {TASKS.map((task, index) => {
        const active = index === activeIndex;
        const showSeparator =
          !active && index < TASKS.length - 1 && index + 1 !== activeIndex;
        return (
          <div
            key={task}
            data-testid="lesson-diorama-task-tab"
            data-active={active ? "" : undefined}
            className={cn(
              "relative flex h-full min-w-0 flex-1 items-center justify-center px-4 text-ui-xs",
              animate && "transition-colors duration-300",
              active
                ? "z-10 rounded-t-lg border-x border-t border-border/90 bg-background font-medium text-foreground"
                : "text-muted-foreground/70",
            )}
          >
            <span className="truncate">{task}</span>
            {showSeparator ? (
              <span className="pointer-events-none absolute top-1/2 right-0 h-4 w-px -translate-y-1/2 bg-border/70" />
            ) : null}
          </div>
        );
      })}
      <span className="flex w-8 shrink-0 items-center justify-center self-center text-muted-foreground">
        +
      </span>
    </div>
  );
}

function TaskSidebar(props: {
  readonly taskScene: TaskScene;
  readonly activeKind: NodeKind;
  readonly animate: boolean;
  readonly className: string;
}) {
  const { activeKind, taskScene, animate } = props;
  return (
    <aside
      data-testid="lesson-diorama-sidebar"
      className={cn(
        "flex min-h-0 flex-col overflow-hidden bg-background",
        props.className,
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <SidebarGroup
          title="Agents"
          activeKind={activeKind}
          animate={animate}
          rows={[
            { kind: "chat", label: taskScene.chat, harnessId: null },
            {
              kind: "terminal-agent",
              label: taskScene.terminal,
              harnessId: taskScene.terminalHarness,
            },
            { kind: "chat", label: taskScene.secondChat, harnessId: null },
            {
              kind: "terminal-agent",
              label: OPENCODE_RUN_LABEL,
              harnessId: "opencode",
            },
            {
              kind: "terminal-agent",
              label: "risk review run",
              harnessId: "codex",
            },
          ]}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border/60">
        <SidebarGroup
          title="Artifacts"
          activeKind={activeKind}
          animate={animate}
          rows={[
            { kind: "spec", label: taskScene.spec, harnessId: null },
            { kind: "ticket", label: taskScene.ticket, harnessId: null },
            { kind: "review", label: taskScene.review, harnessId: null },
            { kind: "spec", label: "grace-period.spec", harnessId: null },
          ]}
        />
      </div>
    </aside>
  );
}

function WorkbenchPanelRail(props: {
  readonly animate: boolean;
  readonly className: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 items-center justify-center gap-1 bg-background px-2 text-muted-foreground",
        props.className,
      )}
    >
      {SIDEBAR_PANEL_RAIL_ITEMS.map((panel) => {
        const Icon = panel.icon;
        return (
          <span
            key={panel.label}
            className={cn(
              "relative flex size-9 items-center justify-center rounded-md",
              props.animate && "transition-colors",
              panel.active ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <Icon className="size-4" />
            {panel.active ? (
              <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-t bg-primary" />
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

function CanvasTopRail(props: { readonly className: string }) {
  return (
    <div
      className={cn(
        "flex min-h-0 items-center justify-end bg-background px-3",
        props.className,
      )}
    >
      <div className="flex items-center gap-1 text-code-xs italic text-muted-foreground/80">
        <span className="size-1.5 rounded-full bg-emerald-400" />
        All changes synced
      </div>
    </div>
  );
}

function SidebarGroup(props: {
  readonly title: string;
  readonly rows: ReadonlyArray<{
    readonly kind: NodeKind;
    readonly label: string;
    readonly harnessId: GuiHarnessId | null;
  }>;
  readonly activeKind: NodeKind;
  readonly animate: boolean;
}) {
  return (
    <div className="py-1.5">
      <div className="flex h-9 items-center gap-2 px-3">
        <ChevronRight className="size-3 shrink-0 rotate-90 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-ui-xs font-normal tracking-wide text-muted-foreground uppercase">
          {props.title}
        </span>
        <Plus className="size-3 shrink-0 text-muted-foreground" />
      </div>
      <div className="flex flex-col gap-0.5 px-2">
        {props.rows.map((row, index) => (
          <SidebarRow
            key={`${props.title}-${row.kind}-${row.label}`}
            kind={row.kind}
            label={row.label}
            harnessId={row.harnessId}
            active={row.kind === props.activeKind && index === 0}
            animate={props.animate}
          />
        ))}
      </div>
    </div>
  );
}

function SidebarRow(props: {
  readonly kind: NodeKind;
  readonly label: string;
  readonly harnessId: GuiHarnessId | null;
  readonly active: boolean;
  readonly animate: boolean;
}) {
  const meta = NODE_META[props.kind];
  const Icon = meta.icon;
  return (
    <div
      data-drag-harness={props.harnessId !== null ? props.harnessId : undefined}
      className={cn(
        "flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-ui-sm font-normal",
        props.animate && "transition-colors",
        props.active
          ? "bg-accent text-accent-foreground"
          : "text-foreground/75",
      )}
    >
      {props.harnessId !== null ? (
        <HarnessIcon
          harnessId={props.harnessId}
          className="size-3.5 shrink-0"
        />
      ) : (
        <Icon className="size-3.5 shrink-0" style={{ color: meta.color }} />
      )}
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
    </div>
  );
}

function CanvasWorkbench(props: {
  readonly scene: LessonDioramaScene;
  readonly animate: boolean;
  readonly activeTaskIndex: number;
  readonly taskScene: TaskScene;
  readonly navigationPhase: NavigationPhase;
}) {
  const { scene, animate, activeTaskIndex, taskScene, navigationPhase } = props;
  // Split-screen animates the build-up; task-tabs keeps a single pane so the
  // tab strip is the only thing that moves.
  const rightVisible =
    scene === "split-screen" &&
    (navigationPhase === "split-1" ||
      navigationPhase === "drag-2" ||
      navigationPhase === "split-2");
  const bottomVisible =
    scene === "split-screen" && navigationPhase === "split-2";
  const paneClass = spotlightClass(scene, "terminal-pane", animate);

  return (
    <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-tl-lg border-l border-t border-canvas-border/80 bg-canvas">
      <div
        className={cn(
          "grid min-h-0 flex-1 overflow-hidden bg-canvas",
          animate &&
            "transition-[grid-template-columns] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
          rightVisible ? "grid-cols-[1fr_1fr]" : "grid-cols-[1fr_0fr]",
        )}
      >
        <MainPane
          scene={scene}
          animate={animate}
          activeTaskIndex={activeTaskIndex}
          taskScene={taskScene}
          splitLeading={rightVisible}
          className={spotlightClass(scene, "main-pane", animate)}
        />
        <div
          className={cn(
            "grid min-h-0 min-w-0 overflow-hidden bg-canvas",
            animate &&
              "transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
            bottomVisible ? "grid-rows-[1fr_1fr]" : "grid-rows-[1fr_0fr]",
          )}
        >
          {rightVisible ? (
            <DemoSplitPane
              harnessId="claude"
              // Tab titles match the sidebar list rows so an open pane maps
              // to a list item.
              label={taskScene.terminal}
              animate={animate}
              compact={bottomVisible}
              divider={false}
              className={paneClass}
            />
          ) : null}
          {bottomVisible ? (
            <DemoSplitPane
              harnessId="opencode"
              label={OPENCODE_RUN_LABEL}
              animate={animate}
              compact
              divider
              className={paneClass}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

/**
 * A terminal-agent pane the split opens. The chrome is the real pane's — tab
 * strip, divider — but the body is a few static sample lines standing in for
 * the terminal, coloured by the shared `--term-ansi-*` tokens so it repaints
 * with the theme. There is no TUI runtime and no mock of one behind it.
 */
function DemoSplitPane(props: {
  readonly harnessId: "claude" | "opencode";
  readonly label: string;
  readonly animate: boolean;
  readonly compact: boolean;
  readonly divider: boolean;
  readonly className: string;
}) {
  return (
    <m.section
      data-testid="lesson-diorama-split-pane"
      data-harness={props.harnessId}
      initial={props.animate ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3, ease: EASE }}
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden bg-canvas",
        props.divider && "border-t border-canvas-border/70",
        props.className,
      )}
    >
      <MiniPaneTabStrip
        animate={props.animate}
        tabs={[
          {
            icon: Terminal,
            harnessId: props.harnessId,
            label: props.label,
            active: true,
            preview: false,
          },
        ]}
      />
      {props.harnessId === "claude" ? (
        <ClaudeSampleLines compact={props.compact} />
      ) : (
        <OpencodeSampleLines />
      )}
    </m.section>
  );
}

function ClaudeSampleLines(props: { readonly compact: boolean }) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas font-mono text-code-xs leading-relaxed text-foreground/85",
        props.compact ? "gap-1.5 p-2.5" : "gap-2.5 p-3",
      )}
    >
      <p className="truncate">
        <span className="font-bold text-foreground">Claude Code</span>{" "}
        <span className="text-muted-foreground">~/work/billing-service</span>
      </p>
      <p className="truncate text-muted-foreground">
        Tracing usage enforcement across the billing service…
      </p>
      <div className="mt-auto flex flex-col gap-1">
        <TerminalRule />
        <p className="flex items-center gap-1.5 leading-none text-foreground/70">
          <span className="leading-none">❯</span>
          <span className="inline-block h-2.5 w-1.5 bg-foreground/70" />
        </p>
        <TerminalRule />
        <p className="truncate">
          <span className="text-[var(--term-ansi-magenta)]">
            billing-service
          </span>{" "}
          <span className="text-muted-foreground">[ctx: </span>
          <span className="text-foreground">33%</span>
          <span className="text-muted-foreground">]</span>
        </p>
      </div>
    </div>
  );
}

function OpencodeSampleLines() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden bg-canvas p-2.5 font-mono text-code-xs leading-relaxed text-foreground/85">
      <p className="truncate border-l-2 border-[var(--term-ansi-blue)]/45 bg-foreground/[0.04] px-2 py-1 text-foreground">
        verify usage paths outside the API
      </p>
      <p className="truncate text-[var(--term-ansi-yellow)]">
        + Thought: 735ms
      </p>
      <p className="mt-auto flex min-w-0 items-center justify-between gap-2">
        <span className="truncate font-medium text-[var(--term-ansi-blue)]">
          Build
        </span>
        <span className="shrink-0 text-muted-foreground">13.7K (7%)</span>
      </p>
    </div>
  );
}

function TerminalRule() {
  return <span className="h-px w-full bg-foreground/35" />;
}

function MiniPaneTabStrip(props: {
  readonly animate: boolean;
  readonly tabs: ReadonlyArray<{
    readonly icon: LucideIcon;
    readonly harnessId: GuiHarnessId | null;
    readonly label: string;
    readonly active: boolean;
    readonly preview: boolean;
  }>;
}) {
  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-canvas-border/70 bg-canvas">
      <div className="no-scrollbar flex min-w-0 flex-1 items-stretch overflow-hidden">
        {props.tabs.map((tab) => (
          <CanvasTab
            key={tab.label}
            icon={tab.icon}
            harnessId={tab.harnessId}
            label={tab.label}
            active={tab.active}
            preview={tab.preview}
            animate={props.animate}
          />
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 border-l border-canvas-border/70 bg-canvas px-1 text-muted-foreground">
        <SplitSquareHorizontal className="size-4" />
        <X className="size-4" />
      </div>
    </div>
  );
}

function CanvasToolbar() {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-canvas-border/70 bg-canvas px-2.5 text-muted-foreground">
      <CanvasToolbarChip icon={Monitor} label="traycer" />
      <CanvasToolbarChip icon={Folder} label="billing-service" />
      <span className="ml-1 flex items-center gap-1 px-1 text-code-xs text-muted-foreground/90">
        <GitBranch className="size-3" />
        Fork
      </span>
    </div>
  );
}

function CanvasToolbarChip(props: {
  readonly icon: LucideIcon;
  readonly label: string;
}) {
  const Icon = props.icon;
  return (
    <span className="flex items-center gap-1 rounded border border-canvas-border/70 bg-background/40 px-1.5 py-0.5 text-code-xs">
      <Icon className="size-3" />
      <span>{props.label}</span>
      <ChevronDown className="size-2.5 opacity-70" />
    </span>
  );
}

function CanvasTab(props: {
  readonly icon: LucideIcon;
  readonly harnessId: GuiHarnessId | null;
  readonly label: string;
  readonly active: boolean;
  readonly preview: boolean;
  readonly animate: boolean;
}) {
  const Icon = props.icon;
  return (
    <div
      data-testid="lesson-diorama-canvas-tab"
      className={cn(
        "relative flex min-w-0 max-w-[10.5rem] items-center gap-1.5 border-r border-canvas-border/70 border-t-2 px-3 text-ui-sm",
        props.animate && "transition-colors duration-300",
        props.active
          ? "border-t-primary bg-background font-medium text-foreground"
          : "border-t-transparent text-muted-foreground",
      )}
    >
      {props.harnessId !== null ? (
        <HarnessIcon
          harnessId={props.harnessId}
          className="size-3.5 shrink-0"
        />
      ) : (
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            props.active ? "text-foreground/80" : "text-muted-foreground/70",
          )}
        />
      )}
      <span className={cn("truncate", props.preview && "italic")}>
        {props.label}
      </span>
    </div>
  );
}

function MainPane(props: {
  readonly scene: LessonDioramaScene;
  readonly animate: boolean;
  readonly activeTaskIndex: number;
  readonly taskScene: TaskScene;
  readonly splitLeading: boolean;
  readonly className: string;
}) {
  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-col overflow-hidden bg-canvas",
        props.splitLeading && "border-r border-canvas-border/70",
        props.className,
      )}
    >
      <MiniPaneTabStrip
        animate={props.animate}
        tabs={[
          {
            icon: MessageSquare,
            harnessId: null,
            label: props.taskScene.canvas,
            active: true,
            preview: false,
          },
          {
            icon: FileText,
            harnessId: null,
            label: props.taskScene.preview,
            active: false,
            preview: true,
          },
          {
            icon: Terminal,
            harnessId: null,
            label: "New Terminal",
            active: false,
            preview: false,
          },
        ]}
      />
      <CanvasToolbar />
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <ChatPane
          scene={props.scene}
          activeTaskIndex={props.activeTaskIndex}
          taskScene={props.taskScene}
        />
      </div>
    </div>
  );
}

function ChatPane(props: {
  readonly scene: LessonDioramaScene;
  readonly activeTaskIndex: number;
  readonly taskScene: TaskScene;
}) {
  const userCopy =
    props.scene === "task-tabs"
      ? `Continue ${TASKS[props.activeTaskIndex].toLowerCase()}`
      : "Let's ship team usage limits.";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col justify-end gap-2 p-3">
        <div
          data-testid="lesson-diorama-chat-sample"
          className="ml-auto max-w-[88%] rounded-lg rounded-br-sm bg-primary px-2.5 py-1.5 text-ui-xs text-primary-foreground"
        >
          {userCopy}
        </div>
        {/* muted-fill-ok: decorative diorama bubble on a literal bg-canvas
            pane; --canvas never equals --muted */}
        <div className="mr-auto flex w-[82%] max-w-[88%] flex-col gap-1.5 rounded-lg rounded-bl-sm bg-muted px-2.5 py-2">
          <span className="h-1.5 w-full rounded-full bg-foreground/15" />
          <span className="h-1.5 w-4/5 rounded-full bg-foreground/15" />
          <span className="h-1.5 w-3/5 rounded-full bg-foreground/15" />
          {props.scene === "task-tabs" ? (
            <span className="mt-1 text-code-xs text-muted-foreground">
              {props.taskScene.spec}
            </span>
          ) : null}
        </div>
      </div>
      <div className="border-t border-border p-2">
        <div className="h-9 rounded-md border border-border bg-background" />
      </div>
    </div>
  );
}

function activeKindFor(scene: LessonDioramaScene): NodeKind {
  return scene === "split-screen" ? "terminal-agent" : "chat";
}

function activeRegionsFor(
  scene: LessonDioramaScene,
): ReadonlyArray<SpotlightRegion> {
  return scene === "split-screen"
    ? ["sidebar", "main-pane", "terminal-pane"]
    : ["task-tabs"];
}

function spotlightClass(
  scene: LessonDioramaScene,
  region: SpotlightRegion,
  animate: boolean,
): string {
  const active = activeRegionsFor(scene).includes(region);
  return cn(
    animate && "transition-[opacity,filter,box-shadow] duration-500",
    active ? "opacity-100 saturate-100" : "opacity-35 saturate-[0.45]",
    active &&
      "shadow-[0_0_0_1px_hsl(var(--primary)/0.22),0_0_2rem_-1rem_hsl(var(--primary)/0.8)]",
  );
}
