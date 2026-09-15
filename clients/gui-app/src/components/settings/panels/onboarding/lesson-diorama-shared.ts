import {
  Bot,
  ClipboardCheck,
  FileCode2,
  FileText,
  Files,
  GitBranch,
  MessageSquare,
  MessagesSquare,
  Ticket,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import type { GuiHarnessId } from "@traycer/protocol/host/agent/shared";

/**
 * Fixtures for the two Settings ▸ Onboarding lesson miniatures
 * (`lesson-diorama.tsx`): the split-screen drag demo and the task-tabs cycle.
 *
 * These were lifted from the first-run tour's desktop diorama when that tour
 * was retired (`Salvage-from` in the deletion commit names the last revision
 * that had it). Only what the two retained scenes read survived the move — a
 * fixture that no scene reads is dead weight, not headroom.
 */

/** The single easing curve every miniature transition uses. */
export const EASE = [0.32, 0.72, 0, 1] as const;

/** The task names the miniature's tab strip lists, in tab order. */
export const TASKS = [
  "Team usage limits",
  "Billing service",
  "Usage sync audit",
] as const;

/** How long each task tab stays active before the strip advances. */
export const TASK_TAB_CYCLE_MS = 1900;

export type NodeKind =
  | "chat"
  | "terminal-agent"
  | "spec"
  | "ticket"
  | "review"
  | "file"
  | "diff";

export const NODE_META: Readonly<
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

/**
 * One entry per task in `TASKS`, in the same order: the sidebar rows, canvas
 * tab and chat sample the miniature shows while that task's tab is active.
 * Changing every field together is what teaches "a tab is a whole task".
 */
export const TASK_SCENES = [
  {
    chat: "Team usage limits",
    terminal: "billing-service run",
    terminalHarness: "claude",
    secondChat: "Grace-period plan",
    spec: "usage-limits.spec",
    ticket: "Grace-period rollout",
    review: "Risk review",
    canvas: "Team usage limits",
    preview: "usage-limits.spec",
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
] as const satisfies ReadonlyArray<{
  readonly chat: string;
  readonly terminal: string;
  readonly terminalHarness: GuiHarnessId;
  readonly secondChat: string;
  readonly spec: string;
  readonly ticket: string;
  readonly review: string;
  readonly canvas: string;
  readonly preview: string;
}>;

export type TaskScene = (typeof TASK_SCENES)[number];

export function taskSceneFor(index: number): TaskScene {
  return TASK_SCENES[index] ?? TASK_SCENES[0];
}

/** The two terminal agents the split-screen demo drags onto the canvas, in order. */
export const NAV_DROP_AGENTS = [
  { harnessId: "claude", label: "Claude Code", startTop: "28%" },
  { harnessId: "opencode", label: "OpenCode", startTop: "58%" },
] as const satisfies ReadonlyArray<{
  readonly harnessId: GuiHarnessId;
  readonly label: string;
  readonly startTop: string;
}>;

/**
 * The second right-pane terminal agent's run name. It must match a sidebar
 * list row so every open pane tab corresponds to a list item; Claude's run
 * name is per-task (`TaskScene.terminal`), OpenCode's is fixed.
 */
export const OPENCODE_RUN_LABEL = "verification run";

export const SIDEBAR_PANEL_RAIL_ITEMS: ReadonlyArray<{
  readonly label: string;
  readonly icon: LucideIcon;
  readonly active: boolean;
}> = [
  { label: "Agents", icon: MessagesSquare, active: true },
  { label: "Git Diff", icon: GitBranch, active: false },
  { label: "Artifacts", icon: Files, active: false },
  { label: "Sharing", icon: UserPlus, active: false },
];

/** The split-screen demo's loop, in order; `NAVIGATION_PHASE_MS` times each. */
export type NavigationPhase =
  | "single"
  | "drag-1"
  | "split-1"
  | "drag-2"
  | "split-2";

export const NAVIGATION_PHASE_MS: Readonly<Record<NavigationPhase, number>> = {
  single: 800,
  "drag-1": 1450,
  "split-1": 1100,
  "drag-2": 1450,
  "split-2": 2000,
};

export const NEXT_NAVIGATION_PHASE: Readonly<
  Record<NavigationPhase, NavigationPhase>
> = {
  single: "drag-1",
  "drag-1": "split-1",
  "split-1": "drag-2",
  "drag-2": "split-2",
  "split-2": "single",
};
