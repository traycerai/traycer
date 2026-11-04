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
    "Claude Code wrote it. Codex reviewed it. I read the diff and merged.\n\nBoth agents in one task with @traycerai, and I'm not going back.",
  ),
  line(
    "line_02",
    "I stopped picking a favorite coding agent. Now I use all of them on the same task, with the same context, in @traycerai.",
  ),
  line(
    "line_03",
    "My agents can finally talk to each other. One plans, one builds, one reviews, and @traycerai keeps them in the same room.",
  ),
  line(
    "line_04",
    "Bring your own agents. Bring your own subscriptions. @traycerai makes them work together.",
  ),
  line(
    "line_05",
    "My terminal used to be nine tabs of agents I'd lost track of. Now it's one task in @traycerai: every chat, diff and terminal in one place.",
  ),
  line(
    "line_06",
    "Gave @traycerai a half-formed idea this morning. Got back a plan, tickets, and agents already working through them.",
  ),
  line(
    "line_07",
    "Asked Claude Code and Codex the same question side by side in @traycerai. Second opinions are underrated for code too.",
  ),
  line(
    "line_08",
    "Started a task on my laptop, checked on the agents from my phone, merged when I got back. @traycerai",
  ),
  line(
    "line_09",
    "If you're juggling more than one coding agent, try @traycerai. One workspace, shared context, and the subscriptions you already pay for.",
  ),
  line(
    "line_10",
    "Spent today reviewing instead of typing. The agents in @traycerai did the typing.",
  ),
  line(
    "line_11",
    "The future isn't one perfect coding agent. It's a team of them. @traycerai is where mine work together.",
  ),
  line(
    "line_12",
    "Put a planner, a builder and a reviewer on one bug in @traycerai. The bug did not stand a chance.",
  ),
  line(
    "line_13",
    "Thanked my coding agent out loud today. In my defense, it was running in @traycerai and it earned it.",
  ),
  line(
    "line_14",
    "@traycerai turned a bug report into a fix, a review and a clean diff while I made coffee.",
  ),
  line(
    "line_15",
    "Every agent has its thing. One for the big refactor, one for the review, and @traycerai to keep them on the same page.",
  ),
  line(
    "line_16",
    "Watching two agents hand work to each other in @traycerai never gets old.",
  ),
  line(
    "line_17",
    "Plans, chats, terminals and diffs, all in one task. @traycerai is the nerve center for my coding agents.",
  ),
  line(
    "line_18",
    "Small team, lots of agents. @traycerai is how we see what every one of them is doing.",
  ),
  line(
    "line_19",
    "No more copy-pasting context between agents. In @traycerai they share the task, so the next one picks up where the last one stopped.",
  ),
  line(
    "line_20",
    "Shipped a feature today where I wrote zero lines and read every one. Agents in @traycerai, review on me.",
  ),
];
