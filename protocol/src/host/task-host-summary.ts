import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  agentReachSchema,
  type AgentReach,
} from "@traycer/protocol/host/agent/shared";
import { z } from "zod";

/**
 * Whose host a task host is: the `{ kind, id }` owner principal
 * traycer-server's task host list carries. It names nobody: the GUI names a
 * team from the person's own teams and a collaborator from the task's
 * collaborator list, and tells the caller's own hosts by its own id.
 */
export type TaskHostPrincipal =
  | { readonly kind: "user"; readonly id: string }
  | { readonly kind: "team"; readonly id: string };

export const taskHostPrincipalSchema: z.ZodType<TaskHostPrincipal> = lazySchema(
  () =>
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("user"), id: z.string().min(1) }),
      z.object({ kind: z.literal("team"), id: z.string().min(1) }),
    ]),
);

/**
 * One host a task shows in its host list (served by `POST /api/tasks/hosts`):
 * the task-authorized summary, and nothing of the owner's sandbox record.
 *
 * - `label` is a sandbox's display name, `null` for a person's host.
 * - `reach` is whether the principal of the host that read the list reaches
 *   this one: the authoritative fact behind "not reachable from this host".
 *
 * No state, cost, payer or route: those need the owner's own authorization,
 * so a reader shows them only from a source it is authorized for.
 */
export interface TaskHostRow {
  readonly hostId: string;
  readonly label: string | null;
  readonly principal: TaskHostPrincipal;
  readonly reach: AgentReach;
}

/** Tolerant: a field a newer server adds is stripped, never refused. */
export const taskHostRowSchema: z.ZodType<TaskHostRow> = lazySchema(() =>
  z.object({
    hostId: z.string().min(1),
    label: z.string().nullable(),
    principal: taskHostPrincipalSchema,
    reach: agentReachSchema,
  }),
);

export const listTaskHostsRequestSchema = lazySchema(() =>
  z.object({
    taskId: z.string().min(1),
  }),
);
export type ListTaskHostsRequest = z.infer<typeof listTaskHostsRequestSchema>;

/** Every host that owns a chat the caller can read in the task. */
export const listTaskHostsResponseSchema = lazySchema(() =>
  z.object({
    hosts: z.array(taskHostRowSchema),
  }),
);
export type ListTaskHostsResponse = z.infer<typeof listTaskHostsResponseSchema>;
