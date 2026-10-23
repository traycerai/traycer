import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  artifactManifestPathSchema,
  artifactObjectRefSchema,
} from "@traycer/protocol/persistence/epic/artifacts";

const versionIdSchema = lazySchema(() => z.string().regex(/^[0-9a-f]{64}$/));
const versionNumberSchema = lazySchema(() => z.number().int().positive());

/** Captured bytes, without the live head's mutable upload status. */
export const htmlArtifactVersionSelectionSchema = lazySchema(() =>
  z
    .object({
      manifest: z.object({
        files: z
          .preprocess(
            (value, ctx) => {
              if (
                typeof value === "object" &&
                value !== null &&
                Object.hasOwn(value, "__proto__")
              ) {
                ctx.addIssue({
                  code: "custom",
                  message: "Invalid artifact manifest path",
                });
                return z.NEVER;
              }
              return value;
            },
            z.record(
              artifactManifestPathSchema,
              artifactObjectRefSchema.omit({ status: true }),
            ),
          )
          .nonoptional(),
        capturedAt: z.number().finite(),
      }),
      entryPath: artifactManifestPathSchema,
      versionNumber: versionNumberSchema.optional(),
    })
    .refine((value) => Object.hasOwn(value.manifest.files, value.entryPath), {
      message: "The captured entry page must be present in its manifest",
      path: ["entryPath"],
    }),
);
export type HtmlArtifactVersionSelection = z.infer<
  typeof htmlArtifactVersionSelectionSchema
>;

export const htmlArtifactVersionSchema = lazySchema(() =>
  htmlArtifactVersionSelectionSchema.safeExtend({
    id: versionIdSchema,
    versionNumber: versionNumberSchema,
  }),
);
export type HtmlArtifactVersion = z.infer<typeof htmlArtifactVersionSchema>;

/** Stable across upload-status changes, manifest key ordering and version numbering. */
export function htmlArtifactVersionIdentity(
  version: HtmlArtifactVersionSelection,
): string {
  return JSON.stringify([
    version.entryPath,
    version.manifest.capturedAt,
    Object.entries(version.manifest.files)
      .sort(([a], [b]) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
      })
      .map(([path, ref]) => [path, ref.sha256, ref.byteLength, ref.mediaType]),
  ]);
}

export const epicListHtmlArtifactVersionsResponseSchema = lazySchema(() =>
  z.object({
    versions: z.array(htmlArtifactVersionSchema),
    nextCursor: versionIdSchema.nullable(),
    currentVersionNumber: versionNumberSchema.nullable(),
  }),
);
export type EpicListHtmlArtifactVersionsResponse = z.infer<
  typeof epicListHtmlArtifactVersionsResponseSchema
>;

export const epicListHtmlArtifactVersionsV10 = defineRpcContract({
  method: "epic.listHtmlArtifactVersions",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: lazySchema(() =>
    z.object({
      epicId: z.string().min(1),
      artifactId: z.string().min(1),
      before: versionIdSchema.optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
  ),
  responseSchema: epicListHtmlArtifactVersionsResponseSchema,
});
