import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { m, useReducedMotion } from "motion/react";
import {
  ArrowRight,
  Bell,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ClipboardCheck,
  Command,
  Download,
  FileCode2,
  FileText,
  Files,
  Folder,
  GitBranch,
  History,
  MessageSquare,
  MessagesSquare,
  Monitor,
  Palette,
  Plus,
  SplitSquareHorizontal,
  Terminal,
  Ticket,
  UserPlus,
  UserCircle,
  X,
  type LucideIcon,
} from "lucide-react";
import { AgentSelectionGuideEditorSurface } from "@/components/agent-selection-guide-editor-surface";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { OnboardingClaudeTui } from "@/components/onboarding/onboarding-claude-tui";
import { OnboardingOpencodeTui } from "@/components/onboarding/onboarding-opencode-tui";
import { ProviderList } from "@/components/providers/provider-list";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { GuiHarnessId } from "@traycer/protocol/host/agent/shared";
import { ORDERED_PROVIDERS } from "@/lib/provider-ordering";
import { cn } from "@/lib/utils";

interface OnboardingDioramaProps {
  readonly stage: number;
  readonly agentGuide: OnboardingAgentGuideState;
}

export interface OnboardingAgentGuideState {
  readonly value: string;
  readonly generatedDefaultContent: string;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: boolean;
  readonly onValueChange: (value: string) => void;
  readonly onRevertToDefault: () => void;
}

type NodeKind =
  "chat" | "terminal-agent" | "spec" | "ticket" | "review" | "file" | "diff";

type SceneId =
  | "task-tabs"
  | "navigation"
  | "task-context"
  | "providers"
  | "agent-guide"
  | "command-theme";

type NavigationPhase = "single" | "drag-1" | "split-1" | "drag-2" | "split-2";
type MeshAgentId = "gui" | "claude" | "opencode";
type SpotlightRegion =
  | "task-tabs"
  | "sidebar"
  | "main-pane"
  | "terminal-pane"
  | "context"
  | "providers"
  | "agent-guide"
  | "command-theme";

const EASE = [0.32, 0.72, 0, 1] as const;

const NODE_META: Readonly<
  Record<NodeKind, { icon: LucideIcon; color: string; label: string }>
> = {
  chat: { icon: MessageSquare, color: "#38bdf8", label: "Chat" },
  "terminal-agent": { icon: Bot, color: "#22d3ee", label: "Terminal Agent" },
  spec: { icon: FileText, color: "#fbbf24", label: "Spec" },
  ticket: { icon: Ticket, color: "#a78bfa", label: "Ticket" },
  review: { icon: ClipboardCheck, color: "#fb7185", label: "Review" },
  file: { icon: FileCode2, color: "#94a3b8", label: "File" },
  diff: { icon: GitBranch, color: "#34d399", label: "Diff" },
};

const TASKS = [
  "Team rate limits",
  "Billing service",
  "Usage sync audit",
] as const;

const TASK_SCENES = [
  {
    chat: "Team rate limits",
    terminal: "billing-service run",
    terminalHarness: "claude",
    secondChat: "Grace-period plan",
    spec: "rate-limits.spec",
    ticket: "Grace-period rollout",
    review: "Risk review",
    canvas: "Team rate limits",
    preview: "rate-limits.spec",
  },
  {
    chat: "Billing service",
    terminal: "enforcement run",
    terminalHarness: "codex",
    secondChat: "API path audit",
    spec: "billing-service.spec",
    ticket: "Enforcement fallback",
    review: "Billing review",
    canvas: "Billing service",
    preview: "billing-service.spec",
  },
  {
    chat: "Usage sync audit",
    terminal: "sync audit run",
    terminalHarness: "codex",
    secondChat: "Bypass checklist",
    spec: "usage-sync.spec",
    ticket: "QA follow-up",
    review: "Usage review",
    canvas: "Usage sync audit",
    preview: "usage-sync.spec",
  },
] as const;

type TaskScene = (typeof TASK_SCENES)[number];
interface NavigationCycleState {
  readonly scene: SceneId;
  readonly phase: NavigationPhase;
}

// Screen 2: the two terminal agents dragged onto the canvas, in order.
const NAV_DROP_AGENTS = [
  { harnessId: "claude", label: "Claude Code", startTop: "28%" },
  { harnessId: "opencode", label: "OpenCode", startTop: "58%" },
] as const satisfies ReadonlyArray<{
  readonly harnessId: GuiHarnessId;
  readonly label: string;
  readonly startTop: string;
}>;

// Screen 3: a scripted agent-to-agent story. Anchors are centers of each pane
// within the workbench (left half = Codex GUI chat, stacked right halves =
// Claude Code + OpenCode terminals). Pills travel between them on handoffs.
const MESH_ANCHORS: Record<
  MeshAgentId,
  { readonly x: string; readonly y: string }
> = {
  gui: { x: "25%", y: "50%" },
  claude: { x: "76%", y: "27%" },
  opencode: { x: "76%", y: "73%" },
};
// Conversational display names (used in story messages + pills).
const PANE_LABEL: Record<MeshAgentId, string> = {
  gui: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
};
// The two right-pane terminal-agent run names. These must match the sidebar
// list rows so an open tab always corresponds to a list item. Claude's run name
// is per-task (taskScene.terminal); OpenCode's is fixed.
const OPENCODE_RUN_LABEL = "verification run";
const PANE_ACCENT_CLASS: Record<MeshAgentId, string> = {
  gui: "border-primary/45 text-primary",
  claude: "border-[var(--term-ansi-cyan)]/50 text-[var(--term-ansi-cyan)]",
  opencode:
    "border-[var(--term-ansi-magenta)]/50 text-[var(--term-ansi-magenta)]",
};

type StoryKind =
  | "user"
  | "chat"
  | "spec"
  | "handoff"
  | "term"
  | "blocked"
  | "msg"
  | "decision";

// The rate-limits collaboration: Codex initiates, Claude gets blocked and asks
// OpenCode, OpenCode answers, Codex records the decision, Claude resumes. Each
// step reveals one message in its pane (`to` drives the directional pill).
const STORY_STEPS = [
  {
    pane: "gui",
    kind: "user",
    text: "We need team rate limits without locking existing customers out.",
    to: null,
  },
  {
    pane: "gui",
    kind: "chat",
    text: "I'll split this into implementation, verification, and risk review.",
    to: null,
  },
  { pane: "gui", kind: "spec", text: "rate-limits.spec", to: null },
  {
    pane: "gui",
    kind: "handoff",
    text: "Claude Code, implement the billing-service check from rate-limits.spec.",
    to: "claude",
  },
  { pane: "claude", kind: "term", text: "reading rate-limits.spec", to: null },
  {
    pane: "claude",
    kind: "blocked",
    text: "background jobs may bypass API checks",
    to: null,
  },
  {
    pane: "claude",
    kind: "handoff",
    text: "OpenCode, verify where usage is consumed outside the API path.",
    to: "opencode",
  },
  {
    pane: "opencode",
    kind: "msg",
    text: "Tracing usage paths across the billing service…",
    to: null,
  },
  {
    pane: "opencode",
    kind: "msg",
    text: "Found 2 paths: API + scheduled sync. Enforcement must live below both.",
    to: "claude",
  },
  {
    pane: "claude",
    kind: "handoff",
    text: "Codex, both paths skip the API layer — where should enforcement live?",
    to: "gui",
  },
  {
    pane: "gui",
    kind: "decision",
    text: "Enforce in the billing service, not the API route. Keep a grace period for existing teams.",
    to: null,
  },
  {
    pane: "gui",
    kind: "handoff",
    text: "Claude, move the check down and add the grace-period branch.",
    to: "claude",
  },
  {
    pane: "claude",
    kind: "term",
    text: "moved check to billing service",
    to: null,
  },
  { pane: "claude", kind: "term", text: "added grace-period branch", to: null },
  { pane: "claude", kind: "term", text: "tests passing", to: null },
  {
    pane: "claude",
    kind: "handoff",
    text: "OpenCode, re-verify both paths now.",
    to: "opencode",
  },
  {
    pane: "opencode",
    kind: "msg",
    text: "Verified API + scheduled sync paths. No bypass found.",
    to: "gui",
  },
  {
    pane: "gui",
    kind: "chat",
    text: "Shipping with the grace period — thanks, both.",
    to: null,
  },
] as const satisfies ReadonlyArray<{
  readonly pane: MeshAgentId;
  readonly kind: StoryKind;
  readonly text: string;
  readonly to: MeshAgentId | null;
}>;

const SIDEBAR_PANEL_RAIL_ITEMS: ReadonlyArray<{
  readonly label: string;
  readonly icon: LucideIcon;
  readonly active: boolean;
}> = [
  { label: "Chats", icon: MessagesSquare, active: true },
  { label: "Git Diff", icon: GitBranch, active: false },
  { label: "Artifacts", icon: Files, active: false },
  { label: "Sharing", icon: UserPlus, active: false },
];

function taskSceneFor(index: number): TaskScene {
  return TASK_SCENES[index] ?? TASK_SCENES[0];
}

const PALETTE_ROWS = [
  { label: "New task", hint: "Cmd N" },
  { label: "New terminal agent", hint: "Cmd T" },
  { label: "Chats", hint: "" },
  { label: "Artifacts", hint: "" },
  { label: "Files", hint: "Cmd P" },
  { label: "View diff", hint: "" },
  { label: "Pick model", hint: "" },
  { label: "Change theme", hint: "" },
] as const;

const THEME_DOCK_SWATCHES = [
  ["#1A2421", "#257174", "Traycer Green"],
  ["oklch(0.205 0 0)", "oklch(0.546 0.245 262.881)", "Blue"],
  ["oklch(0.205 0 0)", "oklch(0.606 0.25 292.717)", "Violet"],
  ["#0b0e14", "#e6b450", "Ayu"],
] as const;

function sceneForStage(stage: number): SceneId {
  if (stage === 0) return "task-tabs";
  if (stage === 1) return "navigation";
  if (stage === 2) return "task-context";
  if (stage === 3) return "providers";
  if (stage === 4) return "agent-guide";
  return "command-theme";
}

export function OnboardingDiorama(props: OnboardingDioramaProps) {
  const { stage, agentGuide } = props;
  const scene = sceneForStage(stage);
  const reducedMotion = useReducedMotion() === true;
  const [taskIndex, setTaskIndex] = useState(0);
  const dragLayerRef = useRef<HTMLDivElement>(null);
  const [navigationCycle, setNavigationCycle] = useState<NavigationCycleState>({
    scene,
    phase: "single",
  });
  const currentNavigationCycle =
    navigationCycle.scene === scene
      ? navigationCycle
      : { scene, phase: "single" as const };
  if (navigationCycle.scene !== scene) {
    setNavigationCycle(currentNavigationCycle);
  }

  useEffect(() => {
    if (scene !== "task-tabs" || reducedMotion) return;
    const id = window.setInterval(
      () => setTaskIndex((index) => (index + 1) % TASKS.length),
      1900,
    );
    return () => window.clearInterval(id);
  }, [scene, reducedMotion]);

  useEffect(() => {
    if (scene !== "navigation" || reducedMotion) return;
    const durations: Record<NavigationPhase, number> = {
      single: 800,
      "drag-1": 1450,
      "split-1": 1100,
      "drag-2": 1450,
      "split-2": 2000,
    };
    const nextPhase: Record<NavigationPhase, NavigationPhase> = {
      single: "drag-1",
      "drag-1": "split-1",
      "split-1": "drag-2",
      "drag-2": "split-2",
      "split-2": "single",
    };
    const id = window.setTimeout(() => {
      setNavigationCycle((current) => {
        if (current.scene !== scene) return current;
        return { ...current, phase: nextPhase[current.phase] };
      });
    }, durations[currentNavigationCycle.phase]);
    return () => window.clearTimeout(id);
  }, [scene, reducedMotion, currentNavigationCycle.phase]);

  const activeTaskIndex = scene === "task-tabs" ? taskIndex : 0;
  const taskScene = taskSceneFor(activeTaskIndex);
  const navigationPhase: NavigationPhase =
    scene === "navigation" && reducedMotion
      ? "split-2"
      : currentNavigationCycle.phase;

  return (
    <div className="relative w-full">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-[10%] bg-[radial-gradient(closest-side,rgba(255,255,255,0.07),transparent_72%)]"
      />
      {scene === "command-theme" ? (
        <div className="relative flex w-full justify-center lg:hidden">
          <CommandPalette reducedMotion={reducedMotion} />
        </div>
      ) : null}
      <div
        data-testid="onboarding-diorama"
        className={cn(
          "relative flex aspect-[16/10] max-h-[var(--onboarding-diorama-max-height)] w-full flex-col overflow-hidden rounded-xl border border-white/12 bg-background text-foreground shadow-[0_2rem_4rem_-1.75rem_rgba(0,0,0,0.72),0_0.875rem_2rem_-1.25rem_rgba(0,0,0,0.55)] transition-colors duration-500",
          // Stacked command-theme shows just the standalone palette above.
          scene === "command-theme" && "max-lg:hidden",
        )}
      >
        <MiniAppHeader activeIndex={activeTaskIndex} className="" />
        <div
          ref={dragLayerRef}
          className="relative min-h-0 flex-1 bg-background"
        >
          <div className="grid h-full min-h-0 overflow-hidden bg-background [--mini-sidebar-width:min(27%,12rem)] [grid-template-columns:var(--mini-sidebar-width)_minmax(0,1fr)] [grid-template-rows:2.5rem_minmax(0,1fr)]">
            <WorkbenchPanelRail className={spotlightClass(scene, "sidebar")} />
            <CanvasTopRail className={spotlightClass(scene, "main-pane")} />
            <TaskSidebar
              taskScene={taskScene}
              activeKind={activeKindFor(scene)}
              className={spotlightClass(scene, "sidebar")}
            />
            <CanvasWorkbench
              scene={scene}
              reducedMotion={reducedMotion}
              activeTaskIndex={activeTaskIndex}
              taskScene={taskScene}
              navigationPhase={navigationPhase}
            />
          </div>
          {scene === "navigation" ? (
            <NavigationDragDemo
              phase={navigationPhase}
              layerRef={dragLayerRef}
            />
          ) : null}
        </div>
        {scene === "providers" ? <ProvidersFocusScene /> : null}
        {scene === "agent-guide" ? (
          <AgentGuideModal
            reducedMotion={reducedMotion}
            agentGuide={agentGuide}
          />
        ) : null}
        {scene === "command-theme" ? (
          <CommandThemeScene reducedMotion={reducedMotion} />
        ) : null}
      </div>
    </div>
  );
}

function NavigationDragDemo(props: {
  readonly phase: NavigationPhase;
  readonly layerRef: { readonly current: HTMLDivElement | null };
}) {
  const { phase, layerRef } = props;
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
        aria-hidden="true"
        key={`zone-${phase}`}
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: [0, 0.55, 0.9, 0.82], scale: [0.98, 1, 1.02, 1] }}
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
        aria-hidden="true"
        key={`pill-${phase}-${startLeft}-${startTop}`}
        initial={{ left: startLeft, top: startTop, opacity: 0, scale: 0.96 }}
        animate={{
          left: [startLeft, startLeft, "78%", "78%"],
          top: [startTop, startTop, endTop, endTop],
          opacity: [0, 1, 1, 0],
          scale: [0.96, 1.03, 1, 0.98],
        }}
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
  readonly className: string;
}) {
  return (
    <header
      className={cn(
        "relative flex h-10 shrink-0 items-center gap-2 bg-canvas px-3 text-canvas-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-border/90 after:content-['']",
        props.className,
      )}
    >
      <div aria-hidden="true" className="flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-[#ff5f57]" />
        <span className="size-2 rounded-full bg-[#ffbd2e]" />
        <span className="size-2 rounded-full bg-[#28c840]" />
      </div>
      <div className="ml-2 flex h-full min-w-0 flex-1 items-end self-stretch">
        <TaskTabs activeIndex={props.activeIndex} />
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

function TaskTabs(props: { readonly activeIndex: number }) {
  const { activeIndex } = props;
  return (
    <div className="flex h-full min-w-0 flex-1 items-end">
      {TASKS.map((task, index) => {
        const active = index === activeIndex;
        const showSeparator =
          !active && index < TASKS.length - 1 && index + 1 !== activeIndex;
        return (
          <div
            key={task}
            className={cn(
              "relative flex h-full min-w-0 flex-1 items-center justify-center px-4 text-ui-xs transition-colors duration-300",
              active
                ? "z-10 rounded-t-lg border-x border-t border-border/90 bg-background font-medium text-foreground"
                : "text-muted-foreground/70",
            )}
          >
            <span className="truncate">{task}</span>
            {showSeparator ? (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 right-0 h-4 w-px -translate-y-1/2 bg-border/70"
              />
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
  readonly className: string;
}) {
  const { activeKind, taskScene } = props;
  return (
    <aside
      className={cn(
        "flex min-h-0 flex-col overflow-hidden bg-background",
        props.className,
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <SidebarGroup
          title="Chats"
          activeKind={activeKind}
          className=""
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
          className=""
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

function WorkbenchPanelRail(props: { readonly className: string }) {
  return (
    <div
      aria-hidden="true"
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
              "relative flex size-9 items-center justify-center rounded-md transition-colors",
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
      aria-hidden="true"
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
  readonly className: string;
}) {
  return (
    <div className={cn("py-1.5", props.className)}>
      <div className="flex h-9 items-center gap-2 px-3">
        <ChevronRight className="size-3 shrink-0 rotate-90 text-muted-foreground transition-transform" />
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
}) {
  const meta = NODE_META[props.kind];
  const Icon = meta.icon;
  return (
    <div
      data-drag-harness={props.harnessId !== null ? props.harnessId : undefined}
      className={cn(
        "flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-ui-sm font-normal transition-colors",
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
  readonly scene: SceneId;
  readonly reducedMotion: boolean;
  readonly activeTaskIndex: number;
  readonly taskScene: TaskScene;
  readonly navigationPhase: NavigationPhase;
}) {
  const { scene, reducedMotion, activeTaskIndex, taskScene, navigationPhase } =
    props;
  const storyStep = useStoryStep(scene, reducedMotion);
  const isNav = scene === "navigation";
  const isStory = scene === "task-context";
  // Navigation animates the build-up; every other non-task-tabs scene keeps the
  // settled 1-left + 2-right shell so tabs/layout stay constant screen to screen.
  const rightVisible = isNav
    ? navigationPhase === "split-1" ||
      navigationPhase === "drag-2" ||
      navigationPhase === "split-2"
    : scene !== "task-tabs";
  const bottomVisible = isNav
    ? navigationPhase === "split-2"
    : scene !== "task-tabs";
  // Tab titles match the sidebar list rows so an open tab maps to a list item.
  const claudeLabel = taskScene.terminal;
  const opencodeLabel = OPENCODE_RUN_LABEL;

  // The A2A scene plays scripted panes; every other scene shows static TUIs.
  const renderRightPane = (
    pane: "claude" | "opencode",
    label: string,
    divider: boolean,
    compact: boolean,
  ) => {
    const paneClass = spotlightClass(scene, "terminal-pane");
    if (isStory) {
      return (
        <ScriptedAgentPane
          pane={pane}
          label={label}
          step={storyStep}
          reducedMotion={reducedMotion}
          divider={divider}
          className={paneClass}
        />
      );
    }
    return (
      <RightTerminalPane
        harnessId={pane}
        label={label}
        reducedMotion={reducedMotion}
        compact={compact}
        divider={divider}
        className={paneClass}
      />
    );
  };

  return (
    <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-tl-lg border-l border-t border-canvas-border/80 bg-canvas">
      <div
        className={cn(
          "grid min-h-0 flex-1 overflow-hidden bg-canvas",
          "transition-[grid-template-columns] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
          rightVisible ? "grid-cols-[1fr_1fr]" : "grid-cols-[1fr_0fr]",
        )}
      >
        <MainPane
          scene={scene}
          reducedMotion={reducedMotion}
          activeTaskIndex={activeTaskIndex}
          taskScene={taskScene}
          storyStep={storyStep}
          splitLeading={rightVisible}
          className={spotlightClass(scene, "main-pane")}
        />
        <div
          className={cn(
            "grid min-h-0 min-w-0 overflow-hidden bg-canvas",
            "transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
            bottomVisible ? "grid-rows-[1fr_1fr]" : "grid-rows-[1fr_0fr]",
          )}
        >
          {rightVisible
            ? renderRightPane("claude", claudeLabel, false, bottomVisible)
            : null}
          {bottomVisible
            ? renderRightPane("opencode", opencodeLabel, true, true)
            : null}
        </div>
      </div>
      {isStory && !reducedMotion ? <StoryPills step={storyStep} /> : null}
    </section>
  );
}

// Drives the scripted A2A story: one extra message revealed per beat, looping
// (a longer hold on the final beat before it resets). Reduced motion shows the
// finished conversation immediately.
// Hold longer on the final beat before looping, and longer on message-passing
// beats (a directional pill is travelling) so the flow is easy to follow.
function storyStepDuration(step: number, last: number): number {
  if (step >= last) return 3200;
  if (STORY_STEPS[step].to !== null) return 2800;
  return 1900;
}

function useStoryStep(scene: SceneId, reducedMotion: boolean): number {
  const [step, setStep] = useState(0);
  const last = STORY_STEPS.length - 1;
  const active = scene === "task-context" && !reducedMotion;
  useEffect(() => {
    if (!active) return;
    const id = window.setTimeout(
      () => setStep((current) => (current >= last ? 0 : current + 1)),
      storyStepDuration(step, last),
    );
    return () => window.clearTimeout(id);
  }, [active, step, last]);
  if (scene !== "task-context") return 0;
  if (reducedMotion) return last;
  return step;
}

// Directional pill on handoff/answer beats, travelling between pane anchors.
function StoryPills(props: { readonly step: number }) {
  const beat = STORY_STEPS[props.step];
  if (beat.to === null) return null;
  const from = MESH_ANCHORS[beat.pane];
  const to = MESH_ANCHORS[beat.to];
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-20"
    >
      <m.div
        key={props.step}
        initial={{ left: from.x, top: from.y, opacity: 0, scale: 0.9 }}
        animate={{
          left: [from.x, from.x, to.x, to.x],
          top: [from.y, from.y, to.y, to.y],
          opacity: [0, 1, 1, 0],
          scale: [0.9, 1, 1, 0.92],
        }}
        transition={{ duration: 2.1, ease: EASE, times: [0, 0.16, 0.86, 1] }}
        className={cn(
          "absolute flex items-center gap-1 rounded-md border bg-popover px-2 py-1 text-overline uppercase tracking-wider shadow-lg",
          PANE_ACCENT_CLASS[beat.pane],
        )}
      >
        <ArrowRight className="size-3" />
        {PANE_LABEL[beat.to]}
      </m.div>
    </div>
  );
}

function RightTerminalPane(props: {
  readonly harnessId: GuiHarnessId;
  readonly label: string;
  readonly reducedMotion: boolean;
  readonly compact: boolean;
  readonly divider: boolean;
  readonly className: string;
}) {
  return (
    <m.section
      initial={props.reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3, ease: EASE }}
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden bg-canvas",
        props.divider && "border-t border-canvas-border/70",
        props.className,
      )}
    >
      <MiniPaneTabStrip
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
        <OnboardingClaudeTui
          reducedMotion={props.reducedMotion}
          compact={props.compact}
          body={null}
        />
      ) : (
        <OnboardingOpencodeTui reducedMotion={props.reducedMotion} />
      )}
    </m.section>
  );
}

function MiniPaneTabStrip(props: {
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
    <div
      aria-hidden="true"
      className="flex h-8 shrink-0 items-center gap-2 border-b border-canvas-border/70 bg-canvas px-2.5 text-muted-foreground"
    >
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
}) {
  const Icon = props.icon;
  return (
    <div
      className={cn(
        "relative flex min-w-0 max-w-[10.5rem] items-center gap-1.5 border-r border-canvas-border/70 border-t-2 px-3 text-ui-sm transition-colors duration-300",
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
  readonly scene: SceneId;
  readonly reducedMotion: boolean;
  readonly activeTaskIndex: number;
  readonly taskScene: TaskScene;
  readonly storyStep: number;
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
          reducedMotion={props.reducedMotion}
          activeTaskIndex={props.activeTaskIndex}
          taskScene={props.taskScene}
          storyStep={props.storyStep}
        />
      </div>
    </div>
  );
}

function ChatPane(props: {
  readonly scene: SceneId;
  readonly reducedMotion: boolean;
  readonly activeTaskIndex: number;
  readonly taskScene: TaskScene;
  readonly storyStep: number;
}) {
  if (props.scene === "task-context") {
    return <AgentChatPane step={props.storyStep} />;
  }
  const userCopy =
    props.scene === "task-tabs"
      ? `Continue ${TASKS[props.activeTaskIndex].toLowerCase()}`
      : "Let's ship team rate limits.";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col justify-end gap-2 p-3">
        <div className="ml-auto max-w-[88%] rounded-lg rounded-br-sm bg-primary px-2.5 py-1.5 text-ui-xs text-primary-foreground">
          {userCopy}
        </div>
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
      {props.scene === "providers" ? null : (
        <div className="border-t border-border p-2">
          <div className="h-9 rounded-md border border-border bg-background" />
        </div>
      )}
    </div>
  );
}

// Screen 4: dim the whole mini-app and float the open harness/model picker
// above it, so focus sits squarely on the provider dropdown.
function ProvidersFocusScene() {
  return (
    <>
      <m.div
        aria-hidden="true"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.25, ease: EASE }}
        className="absolute inset-0 z-20 bg-black/55 supports-backdrop-filter:backdrop-blur-xs"
      />
      {/* Anchored at the chat composer (bottom-left of the left pane), not a
          centered modal — the dropdown reads as the input box's own picker. */}
      <m.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.28, ease: EASE }}
        className="absolute bottom-[5%] left-[29%] z-30 flex w-[min(34%,17rem)] flex-col gap-1.5"
      >
        <OpenHarnessPicker />
        <div className="flex h-9 items-center gap-2 rounded-md border border-border bg-popover px-2 shadow-xl">
          <span className="flex shrink-0 items-center gap-1 rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-code-xs text-foreground/85">
            <HarnessIcon harnessId="claude" className="size-3" />
            Claude Code
            <ChevronUp className="size-2.5 opacity-70" />
          </span>
          <span className="min-w-0 flex-1 truncate text-code-xs text-muted-foreground/60">
            Ask anything…
          </span>
        </div>
      </m.div>
    </>
  );
}

function OpenHarnessPicker() {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-popover shadow-2xl">
      <div className="border-b border-border px-2.5 py-1.5 text-overline uppercase tracking-wider text-muted-foreground">
        Select harness
      </div>
      <ProviderList
        ariaLabel="Diorama harness options"
        variant="diorama"
        className="p-1"
        rows={ORDERED_PROVIDERS.map(({ providerId }) => {
          const active = providerId === "claude-code";
          return {
            providerId,
            active,
            dimmed: false,
            enabled: null,
            badge: null,
            description: null,
            trailing: active ? (
              <Check className="size-3 shrink-0 text-[var(--term-ansi-green)]" />
            ) : null,
            onSelect: null,
          };
        })}
      />
    </div>
  );
}

function visibleBeats(pane: MeshAgentId, step: number) {
  return STORY_STEPS.map((beat, index) => ({ beat, index })).filter(
    (entry) => entry.beat.pane === pane && entry.index <= step,
  );
}

// Left pane: the Codex GUI chat. Reveals Codex's beats (problem, plan, spec,
// handoff, decision) up to the current step, bottom-anchored.
function AgentChatPane(props: { readonly step: number }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col justify-end gap-2 overflow-hidden p-3">
        {visibleBeats("gui", props.step).map(({ beat }) => (
          <GuiMessage
            key={beat.text}
            kind={beat.kind}
            text={beat.text}
            to={beat.to}
          />
        ))}
      </div>
      <div className="border-t border-border p-2">
        <div className="flex h-9 items-center gap-2 rounded-md border border-border bg-background px-2">
          <span className="flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-code-xs text-foreground/80">
            <HarnessIcon harnessId="codex" className="size-3" />
            Codex
          </span>
          <span className="min-w-0 flex-1 truncate text-code-xs text-muted-foreground/60">
            Ask anything…
          </span>
        </div>
      </div>
    </div>
  );
}

function GuiMessage(props: {
  readonly kind: StoryKind;
  readonly text: string;
  readonly to: MeshAgentId | null;
}) {
  // Sent by the human: right-aligned, solid.
  if (props.kind === "user") {
    return (
      <m.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, ease: EASE }}
        className="ml-auto max-w-[88%] rounded-lg rounded-br-sm bg-primary px-2.5 py-1.5 text-ui-xs text-primary-foreground"
      >
        {props.text}
      </m.div>
    );
  }
  // Outgoing handoff to another agent: right-aligned, accent outline.
  if (props.kind === "handoff" && props.to !== null) {
    return (
      <m.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, ease: EASE }}
        className="ml-auto flex max-w-[92%] flex-col gap-1 rounded-lg rounded-br-sm border border-primary/40 bg-primary/10 px-2.5 py-1.5 text-ui-xs"
      >
        <span className="flex items-center gap-1 text-overline uppercase tracking-wider text-primary">
          <ArrowRight className="size-3" />
          to {PANE_LABEL[props.to]}
        </span>
        <span className="text-foreground/85">{props.text}</span>
      </m.div>
    );
  }
  // Spec artifact reference.
  if (props.kind === "spec") {
    return (
      <m.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, ease: EASE }}
        className="mr-auto flex items-center gap-1.5 rounded-md border border-border bg-background/60 px-2 py-1 text-code-xs text-muted-foreground"
      >
        <FileText className="size-3 text-[var(--term-ansi-yellow)]" />
        {props.text}
      </m.div>
    );
  }
  // Received from Codex (chat reply / recorded decision): left-aligned, muted.
  const isDecision = props.kind === "decision";
  return (
    <m.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3, ease: EASE }}
      className="mr-auto flex max-w-[92%] flex-col gap-1 rounded-lg rounded-bl-sm bg-muted px-2.5 py-1.5 text-ui-xs"
    >
      <span className="flex items-center gap-1 text-overline uppercase tracking-wider text-muted-foreground">
        {isDecision ? (
          <>
            <Check className="size-3 text-[var(--term-ansi-green)]" />
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

// Right panes: Claude Code terminal + OpenCode messages, revealed per step,
// bottom-anchored so the latest line stays visible at mini-app scale.
function ScriptedAgentPane(props: {
  readonly pane: "claude" | "opencode";
  readonly label: string;
  readonly step: number;
  readonly reducedMotion: boolean;
  readonly divider: boolean;
  readonly className: string;
}) {
  const beats = visibleBeats(props.pane, props.step);
  if (props.pane === "claude") {
    // Real clawd TUI (mascot/header/status bar) with the A2A session lines
    // rendered in its terminal-body slot.
    return (
      <m.section
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, ease: EASE }}
        className={cn(
          "flex min-h-0 min-w-0 flex-col overflow-hidden bg-canvas",
          props.divider && "border-t border-canvas-border/70",
          props.className,
        )}
      >
        <MiniPaneTabStrip
          tabs={[
            {
              icon: Terminal,
              harnessId: "claude",
              label: props.label,
              active: true,
              preview: false,
            },
          ]}
        />
        <OnboardingClaudeTui
          reducedMotion={props.reducedMotion}
          compact
          body={<ClaudeSessionLines beats={beats} />}
        />
      </m.section>
    );
  }
  return (
    <m.section
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3, ease: EASE }}
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden bg-canvas",
        props.divider && "border-t border-canvas-border/70",
        props.className,
      )}
    >
      <MiniPaneTabStrip
        tabs={[
          {
            icon: Terminal,
            harnessId: "opencode",
            label: props.label,
            active: true,
            preview: false,
          },
        ]}
      />
      <OpencodeStoryBody beats={beats} />
    </m.section>
  );
}

type StoryBeatEntry = {
  readonly beat: (typeof STORY_STEPS)[number];
  readonly index: number;
};

type StoryBeat = (typeof STORY_STEPS)[number];

function claudeLineColor(kind: StoryKind): string {
  if (kind === "blocked") return "text-[var(--term-ansi-yellow)]";
  if (kind === "handoff") return "text-[var(--term-ansi-magenta)]";
  return "text-[var(--term-ansi-green)]";
}

function claudeLineText(beat: StoryBeat): string {
  if (beat.kind === "blocked") return `blocked: ${beat.text}`;
  if (beat.kind === "handoff") return `→ ${PANE_LABEL[beat.to]}: ${beat.text}`;
  return `ok ${beat.text}`;
}

function ClaudeSessionLines(props: {
  readonly beats: ReadonlyArray<StoryBeatEntry>;
}) {
  return (
    <>
      {props.beats.map(({ beat }) => (
        <m.p
          key={beat.text}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.25, ease: EASE }}
          className={cn("truncate", claudeLineColor(beat.kind))}
        >
          {claudeLineText(beat)}
        </m.p>
      ))}
    </>
  );
}

function OpencodeStoryBody(props: {
  readonly beats: ReadonlyArray<StoryBeatEntry>;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-end gap-1.5 overflow-hidden p-3 text-code-xs">
      {props.beats.map(({ beat }) => (
        <m.div
          key={beat.text}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, ease: EASE }}
          className="flex flex-col gap-1 border-l-2 border-[var(--term-ansi-blue)] bg-foreground/[0.04] px-2.5 py-1.5"
        >
          <span className="flex items-center gap-1 text-overline uppercase tracking-wider text-muted-foreground">
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-[2px] bg-[var(--term-ansi-blue)]"
            />
            OpenCode
            {beat.to !== null ? (
              <span className="text-foreground/60">
                → {PANE_LABEL[beat.to]}
              </span>
            ) : null}
          </span>
          <span className="text-foreground/85">{beat.text}</span>
        </m.div>
      ))}
    </div>
  );
}

// Screen 5: the Agents guide as a centered modal over a dimmed app — just the
// guide content, no settings nav chrome.
function AgentGuideModal(props: {
  readonly reducedMotion: boolean;
  readonly agentGuide: OnboardingAgentGuideState;
}) {
  return (
    <>
      <m.div
        aria-hidden="true"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2, ease: EASE }}
        className="absolute inset-0 z-20 bg-black/50 supports-backdrop-filter:backdrop-blur-xs"
      />
      <div className="absolute inset-0 z-30 flex items-center justify-center p-4">
        <m.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.28, ease: EASE }}
          className="flex h-[80%] w-[80%] min-h-0"
        >
          <AgentGuidePane
            reducedMotion={props.reducedMotion}
            agentGuide={props.agentGuide}
          />
        </m.div>
      </div>
    </>
  );
}

function AgentGuidePane(props: {
  readonly reducedMotion: boolean;
  readonly agentGuide: OnboardingAgentGuideState;
}) {
  const { agentGuide } = props;
  const isAtDefault = agentGuide.value === agentGuide.generatedDefaultContent;
  return (
    <AgentSelectionGuideEditorSurface
      titleId="onboarding-agent-selection-guide-heading"
      value={agentGuide.loading ? "" : agentGuide.value}
      onValueChange={agentGuide.onValueChange}
      onBlur={null}
      disabled={agentGuide.loading || agentGuide.saving}
      placeholder={agentGuide.loading ? "Loading…" : undefined}
      ariaLabel="Onboarding agent selection instructions"
      testId="onboarding-agent-guide-input"
      textareaClassName="flex-1 resize-none"
      className="size-full overflow-hidden rounded-lg border border-border bg-card p-4 shadow-2xl"
      revertDisabled={agentGuide.loading || agentGuide.saving || isAtDefault}
      onRevert={agentGuide.onRevertToDefault}
      revertTestId={undefined}
      status={<OnboardingAgentGuideStatus agentGuide={agentGuide} />}
    />
  );
}

function OnboardingAgentGuideStatus(props: {
  readonly agentGuide: OnboardingAgentGuideState;
}) {
  if (props.agentGuide.error) {
    return <span className="text-code-xs text-destructive">Not saved</span>;
  }
  if (props.agentGuide.saving) {
    return (
      <span className="flex items-center gap-1 text-code-xs text-muted-foreground">
        <AgentSpinningDots
          className="text-muted-foreground"
          testId={undefined}
          variant={undefined}
        />
        Saving
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-code-xs text-muted-foreground">
      <ArrowRight className="size-3" />
      Will save when you continue
    </span>
  );
}

function CommandThemeScene(props: { readonly reducedMotion: boolean }) {
  return (
    <>
      <m.div
        aria-hidden="true"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2, ease: EASE }}
        className="absolute inset-0 z-20 bg-black/10 supports-backdrop-filter:backdrop-blur-xs"
      />
      <div className="absolute inset-0 z-30 flex items-center justify-center p-4">
        <CommandPalette reducedMotion={props.reducedMotion} />
      </div>
      <ThemeDock />
    </>
  );
}

// Auto-advance the highlighted palette row so the Cmd+K showcase feels alive.
function useCyclingIndex(count: number, reducedMotion: boolean): number {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (reducedMotion) return;
    const id = window.setTimeout(
      () => setIndex((current) => (current + 1) % count),
      1100,
    );
    return () => window.clearTimeout(id);
  }, [reducedMotion, count, index]);
  return reducedMotion ? 0 : index;
}

function CommandPalette(props: { readonly reducedMotion: boolean }) {
  const selected = useCyclingIndex(PALETTE_ROWS.length, props.reducedMotion);
  return (
    <m.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.32, ease: EASE }}
      className="z-30 flex w-[min(82%,26rem)] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Command className="size-3.5 text-muted-foreground" />
        <span className="text-ui-sm text-muted-foreground">
          Type a command...
        </span>
        <kbd className="ml-auto rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-overline text-muted-foreground">
          Cmd K
        </kbd>
      </div>
      <ul className="flex flex-col p-1">
        {PALETTE_ROWS.map((row, index) => (
          <li
            key={row.label}
            className={cn(
              "flex items-center justify-between rounded-md px-2.5 py-1.5 text-ui-xs transition-colors duration-300",
              index === selected
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground",
            )}
          >
            <span>{row.label}</span>
            {row.hint.length > 0 ? (
              <span className="font-mono text-overline opacity-70">
                {row.hint}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </m.div>
  );
}

function ThemeDock() {
  return (
    <div
      aria-hidden="true"
      className="absolute bottom-[6%] right-[5%] z-30 flex items-center gap-2 rounded-lg border border-border bg-popover/95 px-2.5 py-2 shadow-xl"
    >
      <Palette className="size-3.5 text-muted-foreground" />
      {THEME_DOCK_SWATCHES.map(([bg, accent, label], index) => (
        <span
          key={label}
          className={cn(
            "relative size-6 overflow-hidden rounded-full border transition-transform duration-200",
            index === 0 ? "scale-110 border-foreground" : "border-border",
          )}
          style={{ backgroundColor: bg }}
        >
          <span
            aria-hidden="true"
            className="absolute inset-x-0 bottom-0 h-1/3"
            style={{ backgroundColor: accent }}
          />
        </span>
      ))}
    </div>
  );
}

function activeKindFor(scene: SceneId): NodeKind {
  if (scene === "navigation") return "terminal-agent";
  if (scene === "task-context") return "terminal-agent";
  if (scene === "providers") return "chat";
  if (scene === "agent-guide") return "spec";
  return "chat";
}

function activeRegionsFor(scene: SceneId): ReadonlyArray<SpotlightRegion> {
  if (scene === "task-tabs") return ["task-tabs"];
  if (scene === "navigation") return ["sidebar", "main-pane", "terminal-pane"];
  if (scene === "task-context") {
    return ["main-pane", "terminal-pane", "context"];
  }
  // Providers dims the whole mini-app via a scrim (ProvidersFocusScene) and
  // floats the harness dropdown above it, so no per-region spotlight here.
  if (scene === "providers") return ["sidebar", "main-pane", "terminal-pane"];
  if (scene === "agent-guide") return ["agent-guide"];
  return ["command-theme", "task-tabs"];
}

function spotlightClass(scene: SceneId, region: SpotlightRegion): string {
  const active = activeRegionsFor(scene).includes(region);
  return cn(
    "transition-[opacity,filter,box-shadow] duration-500",
    active ? "opacity-100 saturate-100" : "opacity-35 saturate-[0.45]",
    active &&
      region !== "command-theme" &&
      scene !== "providers" &&
      "shadow-[0_0_0_1px_hsl(var(--primary)/0.22),0_0_2rem_-1rem_hsl(var(--primary)/0.8)]",
  );
}
