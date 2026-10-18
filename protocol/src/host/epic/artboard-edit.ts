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

export const artboardPlacementDeclarationSchema = lazySchema(() =>
  z.object({
    property: z.enum([
      "left",
      "top",
      "margin",
      "margin-left",
      "margin-right",
      "margin-top",
      "margin-bottom",
    ]),
    value: z.string().nullable(),
  }),
);
export type ArtboardPlacementDeclaration = z.infer<
  typeof artboardPlacementDeclarationSchema
>;

export const artboardElementPlacementSchema = lazySchema(() =>
  z.object({
    locator: artboardElementLocatorSchema,
    declarations: z.array(artboardPlacementDeclarationSchema).min(1).max(7),
  }),
);
export type ArtboardElementPlacement = z.infer<
  typeof artboardElementPlacementSchema
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
      expectedText: z.string(),
    }),
    z.object({ kind: z.literal("insert-tid-only") }),
    z.object({ kind: z.literal("delete-element") }),
    z.object({ kind: z.literal("duplicate-element") }),
    z.object({
      kind: z.literal("wrap-text-range"),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
      tag: z.enum(["b", "i", "u", "a"]),
      href: z.string().nullable(),
      expectedText: z.string(),
    }),
    z.object({
      kind: z.literal("unwrap-text-range"),
      expectedText: z.string(),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
      tag: z.enum(["b", "i", "u", "a"]),
    }),
    z.object({
      kind: z.literal("set-css-variable"),
      name: z.string().min(1),
      value: z.string().nullable(),
    }),
    z.object({ kind: z.literal("insert-html-after"), html: z.string() }),
    z.object({
      kind: z.literal("write-asset"),
      fileName: z.string().min(1),
      bytesBase64: z.string(),
      mediaType: z.string().min(1),
      replace: z.boolean(),
    }),
    z.object({
      kind: z.literal("move-element"),
      before: artboardElementLocatorSchema.nullable(),
    }),
    z.object({
      kind: z.literal("set-box"),
      width: z.number().finite().nonnegative().nullable(),
      height: z.number().finite().nonnegative().nullable(),
    }),
    z.object({
      kind: z.literal("align-elements"),
      elements: z.array(artboardElementPlacementSchema).min(1).max(256),
      mode: z.enum(["left", "center", "right", "top", "middle", "bottom"]),
    }),
    z.object({
      kind: z.literal("distribute-elements"),
      elements: z.array(artboardElementPlacementSchema).min(1).max(256),
      axis: z.enum(["x", "y"]),
    }),
    z.object({
      kind: z.literal("wrap-elements"),
      locators: z.array(artboardElementLocatorSchema).min(1).max(256),
      tag: z.enum(["div", "section"]),
      className: z.string().max(4096).nullable(),
    }),
    z.object({ kind: z.literal("unwrap-element") }),
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
      // Present for write-asset; relative to the canvas root, under assets/.
      writtenPath: artifactManifestPathSchema.optional(),
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
