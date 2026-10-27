/**
 * `browser.replicas.list@1.0` - the caller's browser sessions in one epic that
 * run on their OTHER machines, as the answering host holds them.
 *
 * A session belongs to the machine it runs on, and only that machine streams
 * it (`browser.sessions`). Every other host of the same owner holds a replica
 * of its profile and tabs, which is enough to list it and to name the machine
 * a viewer must dial to open it. The answering host's own sessions are never
 * in the answer: its `browser.sessions` stream already carries them.
 *
 * A snapshot as of the session's last published change, so a replica can lag
 * the live session, and its machine may be off.
 */
import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { browserSessionProfileKindSchema } from "@traycer/protocol/host/browser/contracts";

const browserReplicaTabSchema = lazySchema(() =>
  z
    .object({
      tabId: z.string().min(1),
      url: z.string(),
      title: z.string().nullable(),
    })
    .strict(),
);
export type BrowserReplicaTab = z.infer<typeof browserReplicaTabSchema>;

const browserSessionReplicaSchema = lazySchema(() =>
  z
    .object({
      sessionId: z.string().min(1),
      /** The machine that runs the session, the only one that can open it. */
      hostId: z.string().min(1),
      profile: browserSessionProfileKindSchema,
      /** Epoch milliseconds of the session's last published change. */
      lastActivityAt: z.number(),
      tabs: z.array(browserReplicaTabSchema),
    })
    .strict(),
);
export type BrowserSessionReplica = z.infer<typeof browserSessionReplicaSchema>;

export const browserReplicasListRequestSchema = lazySchema(() =>
  z.object({ epicId: z.string().min(1) }).strict(),
);
export type BrowserReplicasListRequest = z.infer<
  typeof browserReplicasListRequestSchema
>;

export const browserReplicasListResponseSchema = lazySchema(() =>
  z.object({ sessions: z.array(browserSessionReplicaSchema) }).strict(),
);
export type BrowserReplicasListResponse = z.infer<
  typeof browserReplicasListResponseSchema
>;

export const browserReplicasListV10 = defineRpcContract({
  method: "browser.replicas.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: browserReplicasListRequestSchema,
  responseSchema: browserReplicasListResponseSchema,
});
