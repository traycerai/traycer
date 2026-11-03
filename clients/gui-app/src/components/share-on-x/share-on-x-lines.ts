import type { AnalyticsShareLineId } from "@/lib/analytics";

export interface ShareOnXLine {
  readonly id: AnalyticsShareLineId;
  readonly text: string;
}

const SITE = "traycer.ai";

function line(id: AnalyticsShareLineId, body: string): ShareOnXLine {
  return { id, text: `${body}\n\n${SITE}` };
}

/**
 * The ready-made posts the share dialog offers. Every id here is allow-listed
 * as a `line_id` analytics value, so a line is replaced by editing its text,
 * never by renumbering.
 */
export const SHARE_ON_X_LINES: ReadonlyArray<ShareOnXLine> = [
  line(
    "line_01",
    "Had Claude Code and Codex working the same bug side by side in @traycerai today. One fixed it, the other reviewed it, and I just watched.",
  ),
  line(
    "line_02",
    "I stopped picking one coding agent. @traycerai runs Claude Code and Codex on the same task and I keep whichever is right.",
  ),
  line(
    "line_03",
    "Plan in one agent, build in another, review in a third. @traycerai keeps them all in the same task.",
  ),
  line(
    "line_04",
    "My coding agents finally share a desk. Chats, terminals and diffs for a task all in one place with @traycerai.",
  ),
  line(
    "line_05",
    "Just shipped a fix without leaving @traycerai. Agent wrote it, second agent reviewed it, I read the diff and merged.",
  ),
  line(
    "line_06",
    "The best part of @traycerai: I can start a task on my laptop and check on the agents from my phone.",
  ),
  line(
    "line_07",
    "Running a few coding agents at once used to mean a wall of terminal tabs. Now it's one task in @traycerai.",
  ),
  line(
    "line_08",
    "Gave @traycerai a fuzzy idea and got back a plan, tickets and the agents to work through them.",
  ),
  line(
    "line_09",
    "Asked two agents the same question in @traycerai and compared the answers. Turns out a second opinion is great for code too.",
  ),
  line(
    "line_10",
    "My agents just closed out a whole task while I was in meetings. @traycerai is how I work now.",
  ),
  line(
    "line_11",
    "If you use more than one coding agent, try @traycerai. It keeps every agent's work for a task in one place.",
  ),
  line(
    "line_12",
    "I keep coming back to @traycerai for the review step: one agent builds, another checks the work before I do.",
  ),
  line(
    "line_13",
    "Today's workflow: describe the change, let the agents in @traycerai plan and build it, read the diff, ship.",
  ),
  line(
    "line_14",
    "Thanked my coding agent out loud today. It was running in @traycerai and it earned it.",
  ),
  line(
    "line_15",
    "Bring your own agents, keep your own subscriptions, and let @traycerai do the coordinating.",
  ),
  line(
    "line_16",
    "Spent the afternoon reviewing instead of typing. My agents in @traycerai did the typing.",
  ),
  line(
    "line_17",
    "@traycerai turned a bug report into a fix, a review and a clean diff while I made coffee.",
  ),
  line(
    "line_18",
    "Every coding agent has its strengths. @traycerai lets me use the right one for each part of the task.",
  ),
  line(
    "line_19",
    "Watching two agents hand work to each other in @traycerai never gets old.",
  ),
  line(
    "line_20",
    "Small team, lots of agents. @traycerai is how we keep track of what each one is doing.",
  ),
];
