import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

export const BROWSER_CATALOG_VERSION = 1 as const;

const identifier = lazySchema(() => z.string().min(1).max(191));
const epicId = lazySchema(() => z.string().min(1).max(36));
export const browserInventoryRevisionSchema = lazySchema(() =>
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
);

export const browserCatalogIdentitySchema = lazySchema(() =>
  z.strictObject({ epicId, hostId: identifier, sessionId: identifier }),
);
export type BrowserCatalogIdentity = z.infer<
  typeof browserCatalogIdentitySchema
>;

/** Discovery metadata only. No runtime, profile, grants or storage state. */
export const browserCatalogRecordSchema = lazySchema(() =>
  browserCatalogIdentitySchema.extend({
    inventoryRevision: browserInventoryRevisionSchema,
    lastActivityAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    tabs: z
      .array(
        z.strictObject({
          tabId: identifier,
          title: z.string().max(4096).nullable(),
          url: z.string().max(16384),
        }),
      )
      .min(1)
      .superRefine((tabs, ctx) => {
        const seen = new Set<string>();
        for (const [index, tab] of tabs.entries()) {
          if (seen.has(tab.tabId))
            ctx.addIssue({
              code: "custom",
              path: [index, "tabId"],
              message: "duplicate tab identity",
            });
          seen.add(tab.tabId);
        }
      }),
  }),
);
export type BrowserCatalogRecord = z.infer<typeof browserCatalogRecordSchema>;

export const browserCatalogDeletionSchema = lazySchema(() =>
  browserCatalogIdentitySchema.extend({
    inventoryRevision: browserInventoryRevisionSchema,
  }),
);
export type BrowserCatalogDeletion = z.infer<
  typeof browserCatalogDeletionSchema
>;

export const browserCatalogReadRequestSchema = lazySchema(() =>
  z.strictObject({ epicId }),
);
export type BrowserCatalogReadRequest = z.infer<
  typeof browserCatalogReadRequestSchema
>;

export const browserCatalogSnapshotSchema = lazySchema(() =>
  z.strictObject({
    version: browserInventoryRevisionSchema,
    records: z.array(browserCatalogRecordSchema),
  }),
);
export type BrowserCatalogSnapshot = z.infer<
  typeof browserCatalogSnapshotSchema
>;
