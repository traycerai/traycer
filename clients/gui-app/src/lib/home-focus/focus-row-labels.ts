import type { FocusAgentRow } from "@/lib/home-focus/focus-model";

/**
 * What a Home row calls the two things it names but cannot always know: a task
 * with no title, and an agent in a task no tile in this window has open.
 *
 * Both views and both densities read these, and so does the Tasks view's nested
 * agent list, so they live beside the model rather than inside one view's
 * component module.
 */

const UNTITLED_TASK = "Untitled task";

export function focusTaskTitleOf(title: string | null): string {
  return title ?? UNTITLED_TASK;
}

/**
 * What Home calls an agent's activity tier wherever it prints one: the status
 * cell, the cold task's summary, the Stop-all list.
 *
 * The wire word for the mid-turn tier is `turn`, and the `FocusAgentRow.tier`
 * union keeps it - but `● turn` on a row read as a noun with no verb, and the
 * user asked for `running`. `background` stays as it is: it matches the
 * Background panel, the background chip and the `N bg` badge, all of which the
 * reader already knows. One helper so the word cannot drift between the three
 * places that say it.
 */
const AGENT_TIER_WORDS: Readonly<Record<FocusAgentRow["tier"], string>> = {
  turn: "running",
  background: "background",
};

export function focusTierWord(tier: FocusAgentRow["tier"]): string {
  return AGENT_TIER_WORDS[tier];
}

/**
 * What a row calls an agent it has no name for.
 *
 * `title` is `null` for every agent in an unmounted task - the activity stream
 * carries ids, tiers and parentage for every task on the host, and names for
 * none of them. Those agents are not rows (a cold task is one row, see
 * `selectTaskGroupBody`), but `via <parent>` and the Stop-all list still name
 * agents, so the fallback is a NAME rather than the lowercase `agent` it used
 * to be, which only ever appeared mid-sentence.
 *
 * Read off the surface where the surface is known, which is the one other fact
 * the row could put here. The two named cases cover a MOUNTED agent whose
 * projection has not filled a title in yet; `Agent` is the rarer mounted agent
 * whose projection has no surface yet either.
 */
const AGENT_SURFACE_NAMES: Readonly<
  Record<NonNullable<FocusAgentRow["surface"]>, string>
> = {
  chat: "Chat",
  "terminal-agent": "Terminal agent",
};

export function focusAgentDisplayName(agent: FocusAgentRow): string {
  if (agent.title !== null) return agent.title;
  if (agent.surface === null) return "Agent";
  return AGENT_SURFACE_NAMES[agent.surface];
}
