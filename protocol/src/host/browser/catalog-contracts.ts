import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

export const BROWSER_CATALOG_VERSION = 1 as const;
export const BROWSER_CATALOG_MAX_TABS = 1000;
export const BROWSER_CATALOG_MAX_PROBES = 200;
export const BROWSER_CATALOG_MAX_RECORDS = 2000;
export const BROWSER_CATALOG_MAX_HOSTS = 1000;

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
      .max(BROWSER_CATALOG_MAX_TABS)
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

/** Emitted only after the owner's persistence/ledger/outbox commit. Never runtime.revision. */
export const browserOwnerInventoryEvidenceSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("live"),
      record: browserCatalogRecordSchema,
    }),
    z.strictObject({
      kind: z.literal("deleted"),
      deletion: browserCatalogDeletionSchema,
    }),
  ]),
);
export type BrowserOwnerInventoryEvidence = z.infer<
  typeof browserOwnerInventoryEvidenceSchema
>;

/** Negotiate before consuming owner evidence or revision-bearing mutation acknowledgments. */
export const browserCatalogCapabilitySchema = lazySchema(() =>
  z.strictObject({
    catalogVersion: z.literal(BROWSER_CATALOG_VERSION),
    durableInventoryRevisions: z.literal(true),
    revisionedMutationAcks: z.literal(true),
  }),
);
export type BrowserCatalogCapability = z.infer<
  typeof browserCatalogCapabilitySchema
>;

/**
 * Owner-authoritative, persisted revision; restart must not reset it. Publish initial
 * before backfill, incomplete while work remains, complete only after all eligible
 * inventory is acknowledged. A later scan can publish incomplete at a newer revision.
 * Absence is unknown/unsupported, never complete-empty.
 */
export const browserCatalogReadinessSchema = lazySchema(() =>
  z.strictObject({
    hostId: identifier,
    indexingRevision: browserInventoryRevisionSchema,
    state: z.enum(["initial", "incomplete", "complete"]),
    capability: browserCatalogCapabilitySchema,
  }),
);
export type BrowserCatalogReadiness = z.infer<
  typeof browserCatalogReadinessSchema
>;

export const browserCatalogReadRequestSchema = lazySchema(() =>
  z
    .strictObject({
      epicId,
      ifVersion: browserInventoryRevisionSchema.optional(),
      // Reconcile journals even if live inventory exceeds snapshot limits.
      evidenceOnly: z.literal(true).optional(),
      // Chunk larger pending journals into requests of MAX_PROBES. Never truncate.
      fenceProbes: z
        .array(browserCatalogIdentitySchema)
        .max(BROWSER_CATALOG_MAX_PROBES),
    })
    .superRefine((request, ctx) => {
      const seen = new Set<string>();
      for (const [index, probe] of request.fenceProbes.entries()) {
        const key = JSON.stringify([probe.hostId, probe.sessionId]);
        if (probe.epicId !== request.epicId || seen.has(key))
          ctx.addIssue({
            code: "custom",
            path: ["fenceProbes", index],
            message: "probe must be unique and scoped to the requested task",
          });
        seen.add(key);
      }
    }),
);
export type BrowserCatalogReadRequest = z.infer<
  typeof browserCatalogReadRequestSchema
>;

export const browserCatalogFenceResultSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    browserCatalogDeletionSchema.extend({ kind: z.literal("fenced") }),
    browserCatalogIdentitySchema.extend({ kind: z.literal("no-fence") }),
  ]),
);
export type BrowserCatalogFenceResult = z.infer<
  typeof browserCatalogFenceResultSchema
>;

const evidenceFields = {
  // Always answered, including when ifVersion equals version. No-fence is NOT an ack.
  fences: lazySchema(() =>
    z.array(browserCatalogFenceResultSchema).max(BROWSER_CATALOG_MAX_PROBES),
  ),
  readiness: lazySchema(() =>
    z.array(browserCatalogReadinessSchema).max(BROWSER_CATALOG_MAX_HOSTS),
  ),
  // Permanent enclosing barriers also suppress authorized cached rows/overlays.
  revokedHostIds: lazySchema(() =>
    z.array(identifier).max(BROWSER_CATALOG_MAX_HOSTS),
  ),
};
export const browserCatalogSnapshotSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("snapshot"),
      version: browserInventoryRevisionSchema,
      ...evidenceFields,
      records: z
        .array(browserCatalogRecordSchema)
        .max(BROWSER_CATALOG_MAX_RECORDS),
    }),
    z.strictObject({
      kind: z.literal("not-modified"),
      version: browserInventoryRevisionSchema,
      ...evidenceFields,
    }),
    z.strictObject({
      kind: z.literal("evidence"),
      // This is NOT live snapshot coverage and must never become ifVersion.
      headVersion: browserInventoryRevisionSchema,
      ...evidenceFields,
    }),
  ]),
);
export type BrowserCatalogSnapshot = z.infer<
  typeof browserCatalogSnapshotSchema
>;

/** Successful durable mutation; evidence is journaled before its tile is retired. */
export const browserInventoryMutationAckSchema = lazySchema(() =>
  z.strictObject({
    requestId: identifier,
    evidence: browserOwnerInventoryEvidenceSchema,
  }),
);
export type BrowserInventoryMutationAck = z.infer<
  typeof browserInventoryMutationAckSchema
>;

/** Owner snapshots/events share this evidence; legacy streams keep their original shape. */
export const browserOwnerInventorySnapshotSchema = lazySchema(() =>
  z
    .strictObject({
      epicId,
      hostId: identifier,
      sessions: z
        .array(browserOwnerInventoryEvidenceSchema)
        .max(BROWSER_CATALOG_MAX_RECORDS),
    })
    .superRefine((snapshot, ctx) => {
      const seen = new Set<string>();
      for (const [index, evidence] of snapshot.sessions.entries()) {
        const identity =
          evidence.kind === "live" ? evidence.record : evidence.deletion;
        if (
          identity.epicId !== snapshot.epicId ||
          identity.hostId !== snapshot.hostId ||
          seen.has(identity.sessionId)
        )
          ctx.addIssue({
            code: "custom",
            path: ["sessions", index],
            message:
              "owner evidence must be unique and scoped to its owner and task",
          });
        seen.add(identity.sessionId);
      }
    }),
);
export type BrowserOwnerInventorySnapshot = z.infer<
  typeof browserOwnerInventorySnapshotSchema
>;
