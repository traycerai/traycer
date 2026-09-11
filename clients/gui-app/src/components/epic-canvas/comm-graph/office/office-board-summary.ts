/**
 * What a BOARD says: how the agents it names are spending this moment.
 *
 * Three buckets and an archived count, because that is the whole of what the
 * GUI can honestly report - there is no ticket link and no completion signal,
 * so a board that promised a burndown would be inventing one.
 *
 * Renderer-side rather than part of the plan, for the same reason the rest of
 * the signage is: a board summarises the statuses AS OF the cursor, and the
 * plan does not know what the cursor is.
 */
import type { OfficeAgentStatus } from "@/lib/comm-graph/office/office-types";

export function officeBoardSummary(
  agentIds: ReadonlyArray<string>,
  statusById: ReadonlyMap<string, OfficeAgentStatus>,
): string {
  let doing = 0;
  let waiting = 0;
  let idle = 0;
  let archived = 0;
  for (const agentId of agentIds) {
    const status = statusById.get(agentId) ?? "idle";
    if (status === "working" || status === "background") doing += 1;
    else if (status === "archived") archived += 1;
    else if (status === "idle") idle += 1;
    else waiting += 1;
  }
  const parts = [`${doing} doing`, `${waiting} waiting`, `${idle} idle`];
  if (archived > 0) parts.push(`${archived} archived`);
  return parts.join(" · ");
}
