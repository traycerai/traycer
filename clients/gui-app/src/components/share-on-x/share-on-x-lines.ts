import type { AnalyticsShareLineId } from "@/lib/analytics";

export interface ShareOnXLine {
  readonly id: AnalyticsShareLineId;
  readonly text: string;
}

/**
 * What a ready-made post may say about the person: only counts and names
 * read from their own setup and usage, never what a task was about or what
 * happened in it.
 */
export interface ShareOnXLineContext {
  /** Agents set up and signed in on this machine. */
  readonly setUpAgents: ReadonlyArray<string>;
  /** The task's last 7 days; `null` before its usage is known or with none. */
  readonly task: {
    /** Agents (chats) that worked on the task. */
    readonly agentCount: number;
    /** The coding agents they ran on, most tokens first. */
    readonly harnesses: ReadonlyArray<string>;
    readonly tokens: number;
    /** Machines the work ran on. */
    readonly machineCount: number;
  } | null;
}

/**
 * A ready-made post. One that can mention the person's own numbers says them
 * when they hold, and otherwise reads as its generic fallback, so every post
 * always has text.
 */
export interface ShareOnXLineSource {
  readonly id: AnalyticsShareLineId;
  readonly write: (context: ShareOnXLineContext) => string;
}

/** Most agents a post names before it counts the rest. */
const MAX_NAMED = 3;

/** Fewest tokens a post quotes; below this the number undersells. */
const MIN_QUOTED_TOKENS = 100_000;

const AGENT_LIST = new Intl.ListFormat("en", {
  style: "long",
  type: "conjunction",
});

const COMPACT_NUMBER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const COUNT_WORDS = [
  "Zero",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
];

function agentList(names: ReadonlyArray<string>): string {
  if (names.length <= MAX_NAMED) return AGENT_LIST.format(names);
  return AGENT_LIST.format([
    ...names.slice(0, MAX_NAMED),
    `${String(names.length - MAX_NAMED)} more`,
  ]);
}

function fixed(id: AnalyticsShareLineId, text: string): ShareOnXLineSource {
  return { id, write: () => text };
}

/**
 * Posts that can quote the person's own setup and usage, offered first.
 * Every id here and below is allow-listed as a `line_id` analytics value, so
 * a post is replaced by editing its text, never by renumbering.
 */
const PERSONAL_LINES: ReadonlyArray<ShareOnXLineSource> = [
  {
    id: "line_01",
    write: ({ setUpAgents }) =>
      setUpAgents.length >= 2
        ? `${agentList(setUpAgents)}, all set up in one @traycerai workspace.`
        : "One workspace for all your coding agents. @traycerai",
  },
  {
    id: "line_02",
    write: ({ task }) =>
      task !== null && task.agentCount >= 2
        ? `${String(task.agentCount)} agents on one task in the last 7 days. @traycerai`
        : "One task, several coding agents, shared context. That's @traycerai.",
  },
  {
    id: "line_03",
    write: ({ task }) =>
      task !== null && task.harnesses.length >= 2
        ? `${agentList(task.harnesses)} on the same task in @traycerai.`
        : "@traycerai gives your coding agents shared context on a task.",
  },
  {
    id: "line_04",
    write: ({ task }) =>
      task !== null && task.tokens >= MIN_QUOTED_TOKENS && task.agentCount >= 2
        ? `About ${COMPACT_NUMBER.format(task.tokens)} tokens across ${String(task.agentCount)} agents on one task in the last 7 days. @traycerai`
        : "Claude Code, Codex and more coding agents on the same task in @traycerai.",
  },
  {
    id: "line_05",
    write: ({ task }) =>
      task !== null && task.machineCount >= 2 && task.agentCount >= 2
        ? `${String(task.agentCount)} agents across ${String(task.machineCount)} machines, one task. @traycerai`
        : "In @traycerai, one task's agents can run on more than one machine.",
  },
  {
    id: "line_06",
    write: ({ setUpAgents }) =>
      setUpAgents.length >= 3
        ? `${COUNT_WORDS.at(setUpAgents.length) ?? String(setUpAgents.length)} coding agents signed in, one workspace. @traycerai`
        : "Bring your own coding agents and subscriptions to @traycerai.",
  },
];

const FIXED_LINES: ReadonlyArray<ShareOnXLineSource> = [
  fixed(
    "line_07",
    "If you use more than one coding agent, give @traycerai a look.",
  ),
  fixed("line_08", "Working with coding agents? @traycerai is worth a try."),
  fixed(
    "line_09",
    "Hand a task from one coding agent to another, context included. @traycerai",
  ),
  fixed(
    "line_10",
    "Pick the right coding agent for each part of a task. @traycerai",
  ),
  fixed(
    "line_11",
    "Coding agents side by side, and one place to follow them all. @traycerai",
  ),
  fixed("line_12", "Multi-agent coding, one task at a time. @traycerai"),
  fixed(
    "line_13",
    "Several coding agents, one task, one place to review the work. @traycerai",
  ),
  fixed(
    "line_14",
    "Your coding agents, your subscriptions, one workspace. @traycerai",
  ),
  fixed(
    "line_15",
    "In @traycerai, coding agents can share context within a task.",
  ),
  fixed(
    "line_16",
    "One place to see what every agent on a task is doing. @traycerai",
  ),
  fixed("line_17", "Shared context across coding agents, built in. @traycerai"),
  fixed("line_18", "An app for running coding agents together: @traycerai"),
  fixed(
    "line_19",
    "Agents, chats, terminals and diffs for a task, in one place. @traycerai",
  ),
  fixed("line_20", "A team of coding agents on one task. That's @traycerai."),
];

function shuffled<T>(items: ReadonlyArray<T>): ReadonlyArray<T> {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

/**
 * Every ready-made post in the order the dialog offers them: the ones that
 * can quote the person's numbers first, then the rest, each group shuffled.
 */
export function shuffledShareOnXLines(): ReadonlyArray<ShareOnXLineSource> {
  return [...shuffled(PERSONAL_LINES), ...shuffled(FIXED_LINES)];
}
