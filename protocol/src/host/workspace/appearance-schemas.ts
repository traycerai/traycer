import { z } from "zod";

export const APPEARANCE_SYMBOLS = [
  "folder",
  "code",
  "terminal",
  "rocket",
  "globe",
  "book",
  "box",
  "cpu",
  "database",
  "flask-conical",
  "heart",
  "sparkles",
] as const;
export const MAX_APPEARANCE_WALLPAPER_BYTES = 4 * 1024 * 1024;
export const MAX_APPEARANCE_ICON_BYTES = 256 * 1024;
export const appearanceAssetPathSchema = z
  .string()
  .regex(/^appearance\/[A-Za-z0-9_-]+\.(?:png|jpg|jpeg|webp)$/);
export const appearanceColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const appearanceIconSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("symbol"), value: z.enum(APPEARANCE_SYMBOLS) }),
  z.object({
    kind: z.literal("emoji"),
    value: z
      .string()
      .min(1)
      .max(32)
      .regex(
        /^(?:\p{Extended_Pictographic}[\p{Emoji_Modifier}\uFE0F]*(?:\u200D\p{Extended_Pictographic}[\p{Emoji_Modifier}\uFE0F]*)*|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)$/u,
      ),
  }),
  z.object({ kind: z.literal("image"), path: appearanceAssetPathSchema }),
]);
export const appearanceWallpaperImageSchema = z.object({
  kind: z.literal("image"),
  path: appearanceAssetPathSchema,
  focalPoint: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
  treatment: z.enum(["original", "texture", "dither"]),
  dimming: z.number().min(0).max(1),
  strength: z.number().min(0).max(1),
});
export const appearanceWallpaperSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  appearanceWallpaperImageSchema,
]);
export const workspaceAppearanceSchema = z.object({
  version: z.literal(1),
  color: appearanceColorSchema.optional(),
  icon: appearanceIconSchema.optional(),
  wallpaper: appearanceWallpaperSchema.optional(),
});
export type WorkspaceAppearance = z.infer<typeof workspaceAppearanceSchema>;
export const workspaceAppearancePatchSchema = z.object({
  color: appearanceColorSchema.nullable().optional(),
  icon: appearanceIconSchema.nullable().optional(),
  wallpaper: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }),
      appearanceWallpaperImageSchema.extend({
        path: appearanceAssetPathSchema.optional(),
      }),
    ])
    .nullable()
    .optional(),
});
export type WorkspaceAppearancePatch = z.infer<
  typeof workspaceAppearancePatchSchema
>;
export const appearanceUploadSchema = z.object({
  target: z.enum(["icon", "wallpaper"]),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  dataBase64: z
    .string()
    .min(4)
    .max(Math.ceil(MAX_APPEARANCE_WALLPAPER_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
export type AppearanceUpload = z.infer<typeof appearanceUploadSchema>;
export const workspaceAppearanceReadSchema = z.object({
  workspacePath: z.string(),
  canonicalSourceRoot: z.string().nullable(),
  status: z.enum([
    "present",
    "absent",
    "non-git",
    "unavailable",
    "malformed",
    "unsupported",
  ]),
  revision: z.string().nullable(),
  appearance: workspaceAppearanceSchema.nullable(),
  issues: z.array(z.string()),
});
export type WorkspaceAppearanceRead = z.infer<
  typeof workspaceAppearanceReadSchema
>;
export const workspaceGetAppearanceRequestSchema = z.object({
  workspacePaths: z.array(z.string().min(1).max(4096)).min(1).max(32),
});
export const workspaceGetAppearanceResponseSchema = z.object({
  appearances: z.array(workspaceAppearanceReadSchema),
});
export type WorkspaceGetAppearanceRequest = z.infer<
  typeof workspaceGetAppearanceRequestSchema
>;
export type WorkspaceGetAppearanceResponse = z.infer<
  typeof workspaceGetAppearanceResponseSchema
>;
export const workspaceSetAppearanceRequestSchema = z.object({
  epicId: z.string(),
  workspacePath: z.string().min(1).max(4096),
  expectedRevision: z.string().max(64).nullable(),
  patch: workspaceAppearancePatchSchema,
  uploads: z.array(appearanceUploadSchema).max(2),
});
export type WorkspaceSetAppearanceRequest = z.infer<
  typeof workspaceSetAppearanceRequestSchema
>;
export const workspaceSetAppearanceResponseSchema = z.object({
  status: z.enum(["saved", "conflict"]),
  appearance: workspaceAppearanceReadSchema,
});
export type WorkspaceSetAppearanceResponse = z.infer<
  typeof workspaceSetAppearanceResponseSchema
>;
