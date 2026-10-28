import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  browserCatalogReadRequestSchema,
  browserCatalogSnapshotSchema,
} from "./catalog-contracts";

/** Stateless relay of the caller's task inventory. */
export const browserCatalogReadResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("available"),
      snapshot: browserCatalogSnapshotSchema,
    }),
    z.strictObject({ kind: z.literal("local-only") }),
    z.strictObject({ kind: z.literal("inaccessible") }),
    z.strictObject({ kind: z.literal("unavailable") }),
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
