import type { MutationScope } from "@tanstack/react-query";

/**
 * The Claude session name template's write queue, keyed by host. The
 * coordinator queues `config.sessionNames.set` by its params, so two saves of
 * different templates sit in two queues and race; without one queue the host
 * can end on the older template while the field shows the user's last choice.
 */
export function sessionNamesWriteScope(hostId: string): MutationScope {
  return { id: `config.sessionNames.set:${hostId}` };
}
