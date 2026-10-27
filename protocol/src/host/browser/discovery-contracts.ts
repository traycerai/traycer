import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  browserCatalogReadRequestSchema,
  browserCatalogSnapshotSchema,
} from "./catalog-contracts";

/**
 * A stateless reader of the caller's task inventory. The client owns cached
 * inventory, pending owner evidence, probe chunking and active-view repair.
 */
export const browserCatalogReadResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("available"),
      snapshot: browserCatalogSnapshotSchema,
    }),
    // Suppress cloud inventory and retain the existing local session path.
    z.strictObject({ kind: z.literal("local-only") }),
    // Drop cached inventory and pending evidence for this caller/task.
    z.strictObject({ kind: z.literal("inaccessible") }),
    // Keep the legacy owner path; missing support proves no completeness.
    z.strictObject({ kind: z.literal("unsupported") }),
    // No inventory assertion. Authorized cached data may remain visibly stale.
    z.strictObject({
      kind: z.literal("unavailable"),
      reason: z.enum(["cloud", "cloud-verdict", "inventory-limit"]),
    }),
  ]),
);
export type BrowserCatalogReadResponse = z.infer<
  typeof browserCatalogReadResponseSchema
>;

export const browserCatalogReadV10 = defineRpcContract({
  method: "browser.catalog.read",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: browserCatalogReadRequestSchema,
  responseSchema: browserCatalogReadResponseSchema,
});
