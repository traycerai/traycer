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
 * What a row calls an agent it has no name for.
 *
 * `title` is `null` for every agent in an unmounted task - the activity stream
 * carries ids, tiers and parentage for every task on the host, and names for
 * none of them - and those agents are rows now, so the fallback is a NAME
 * rather than the lowercase `agent` it used to be, which only ever appeared
 * mid-sentence as `via agent`.
 *
 * Read off the surface where the surface is known, which is the one other fact
 * the row could put here. Cold agents carry no surface either (an identity is
 * resolved or it is not), so in practice `Agent` is what a cold task's chats
 * read as, and the two named cases cover a MOUNTED agent whose projection has
 * not filled a title in yet.
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
