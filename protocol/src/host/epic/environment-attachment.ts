import { z } from "zod";

import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * `epic.attachEnvironment`: attach a task to a team's environment so that
 * team's hosts may serve it. Called on the person's OWN host, which resolves
 * the team's environment and forwards the attachment to the cloud with the
 * person's bearer: the attachment is the person's act, and a team host is
 * refused it. The cloud requires the caller to own the task (a task the team
 * already owns needs nothing) and to belong to the team; attaching twice is a
 * no-op.
 */
export const attachEnvironmentRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    teamId: z.string().min(1),
  }),
);
export type AttachEnvironmentRequest = z.infer<
  typeof attachEnvironmentRequestSchema
>;

export const attachEnvironmentResponseSchema = lazySchema(() =>
  z.object({ attached: z.literal(true) }),
);
export type AttachEnvironmentResponse = z.infer<
  typeof attachEnvironmentResponseSchema
>;
