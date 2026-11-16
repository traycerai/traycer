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

/**
 * `epic.attachEnvironment@2.0`: the person's own host prepares the task for a
 * team's environment and attaches nothing. It answers once the task has a
 * home in the cloud (a local create still promoting is promoted and waited
 * for), with the same refusals as `@1.0`'s share gate. The attachment itself
 * is then the app's own call to the cloud on the person's sign-in.
 */
export const attachEnvironmentRequestSchemaV20 = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
  }),
);
export type AttachEnvironmentRequestV20 = z.infer<
  typeof attachEnvironmentRequestSchemaV20
>;

export const attachEnvironmentResponseSchemaV20 = lazySchema(() =>
  z.object({ prepared: z.literal(true) }),
);
export type AttachEnvironmentResponseV20 = z.infer<
  typeof attachEnvironmentResponseSchemaV20
>;
