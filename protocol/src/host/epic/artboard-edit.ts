import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { artifactManifestPathSchema } from "@traycer/protocol/persistence/epic/artifacts";

export const artboardElementLocatorSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("position"),
      startTagOffset: z.number().int().nonnegative(),
      tagName: z.string().min(1),
    }),
    z.object({ kind: z.literal("tid"), tid: z.string().min(1) }),
  ]),
);
export type ArtboardElementLocator = z.infer<
  typeof artboardElementLocatorSchema
>;

export const artboardEditSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("set-style"),
      property: z.string().min(1),
      value: z.string().nullable(),
    }),
    z.object({
      kind: z.literal("set-attribute"),
      name: z.string().min(1),
      value: z.string().nullable(),
    }),
    z.object({ kind: z.literal("set-text-content"), text: z.string() }),
    z.object({
      kind: z.literal("set-text-node"),
      index: z.number().int().nonnegative(),
      text: z.string(),
    }),
    z.object({ kind: z.literal("insert-tid-only") }),
    z.object({ kind: z.literal("delete-element") }),
    z.object({ kind: z.literal("duplicate-element") }),
  ]),
);
export type ArtboardEdit = z.infer<typeof artboardEditSchema>;

export const epicEditArtboardRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    artifactId: z.string().min(1),
    boardPath: artifactManifestPathSchema,
    servedSha256: z.string().regex(/^[0-9a-f]{64}$/),
    locator: artboardElementLocatorSchema,
    fallbackTid: z.string().min(1).nullable(),
    edit: artboardEditSchema,
  }),
);
export type EpicEditArtboardRequest = z.infer<
  typeof epicEditArtboardRequestSchema
>;

export const epicEditArtboardResponseSchema = lazySchema(() =>
  z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      tid: z.string().nullable(),
      sha256After: z.string().regex(/^[0-9a-f]{64}$/),
      // Half-open UTF-16 ranges in the original decoded file, including BOM.
      splices: z.array(
        z.object({
          start: z.number().int().nonnegative(),
          end: z.number().int().nonnegative(),
          replacement: z.string(),
        }),
      ),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.string().min(1),
      detail: z.string(),
    }),
  ]),
);
export type EpicEditArtboardResponse = z.infer<
  typeof epicEditArtboardResponseSchema
>;

export const epicEditArtboardV10 = defineRpcContract({
  method: "epic.editArtboard",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: epicEditArtboardRequestSchema,
  responseSchema: epicEditArtboardResponseSchema,
});
