import { z } from "zod";
import { MAX_APPEARANCE_ICON_BYTES } from "./appearance-asset-policy";

export { MAX_APPEARANCE_ICON_BYTES };
export const appearanceAssetPathSchema = z
  .string()
  .regex(/^appearance\/[A-Za-z0-9_-]+\.(?:png|jpg|jpeg|webp)$/);
export const appearanceColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const appearanceIconSchema = z.discriminatedUnion("kind", [
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
export const workspaceAppearanceSchema = z.object({
  version: z.literal(1),
  color: appearanceColorSchema.optional(),
  icon: appearanceIconSchema.optional(),
});
export type WorkspaceAppearance = z.infer<typeof workspaceAppearanceSchema>;
export const workspaceAppearancePatchSchema = z.object({
  color: appearanceColorSchema.nullable().optional(),
  icon: appearanceIconSchema.nullable().optional(),
});
export type WorkspaceAppearancePatch = z.infer<
  typeof workspaceAppearancePatchSchema
>;
/** The one logo a save may carry; its stored path is derived from its bytes. */
export const appearanceUploadSchema = z.object({
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  dataBase64: z
    .string()
    .min(4)
    .max(Math.ceil(MAX_APPEARANCE_ICON_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
export type AppearanceUpload = z.infer<typeof appearanceUploadSchema>;
export const workspaceAppearanceReadSchema = z.object({
  workspacePath: z.string(),
  canonicalSourceRoot: z.string().nullable(),
  // An unrecognized `version` reads as `malformed`: the host has one schema.
  status: z.enum(["present", "absent", "non-git", "unavailable", "malformed"]),
  appearance: workspaceAppearanceSchema.nullable(),
  // Machine field names (a client can key `invalidFields.includes("icon")`).
  invalidFields: z.array(z.enum(["color", "icon"])),
  // Human-readable sentences, for surfaces that just render a reason.
  messages: z.array(z.string()),
});
export type WorkspaceAppearanceRead = z.infer<
  typeof workspaceAppearanceReadSchema
>;
export const workspaceGetAppearanceRequestSchema = z.object({
  workspacePath: z.string().min(1).max(4096),
});
export const workspaceGetAppearanceResponseSchema = z.object({
  appearance: workspaceAppearanceReadSchema,
});
export type WorkspaceGetAppearanceRequest = z.infer<
  typeof workspaceGetAppearanceRequestSchema
>;
export type WorkspaceGetAppearanceResponse = z.infer<
  typeof workspaceGetAppearanceResponseSchema
>;
/** Last write wins: identity is one small committed file, edited by one person. */
export const workspaceSetAppearanceRequestSchema = z.object({
  epicId: z.string(),
  workspacePath: z.string().min(1).max(4096),
  patch: workspaceAppearancePatchSchema,
  upload: appearanceUploadSchema.nullable(),
});
export type WorkspaceSetAppearanceRequest = z.infer<
  typeof workspaceSetAppearanceRequestSchema
>;
export const workspaceSetAppearanceResponseSchema = z.object({
  appearance: workspaceAppearanceReadSchema,
});
export type WorkspaceSetAppearanceResponse = z.infer<
  typeof workspaceSetAppearanceResponseSchema
>;
