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

/** `title` is `null` for every agent in an unmounted task - the activity stream
 * carries ids and tiers for every task on the host, and names for none of
 * them. */
export function focusAgentDisplayName(agent: FocusAgentRow): string {
  return agent.title ?? "agent";
}
