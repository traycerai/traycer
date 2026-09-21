import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

export const runtimeCapabilitiesRequestSchema = lazySchema(() =>
  z.object({}).strict(),
);
export type RuntimeCapabilitiesRequest = z.infer<
  typeof runtimeCapabilitiesRequestSchema
>;

export const chatMessageListCapabilityProviderSchema = lazySchema(() =>
  z.literal("virtuoso-message-list"),
);
export type ChatMessageListCapabilityProvider = z.infer<
  typeof chatMessageListCapabilityProviderSchema
>;

export const runtimeCapabilityUnavailableReasonSchema = lazySchema(() =>
  z.enum(["license-key-unavailable"]),
);
export type RuntimeCapabilityUnavailableReason = z.infer<
  typeof runtimeCapabilityUnavailableReasonSchema
>;

export const chatMessageListLicenseModeSchema = lazySchema(() =>
  z.enum(["licensed", "development-trial"]),
);
export type ChatMessageListLicenseMode = z.infer<
  typeof chatMessageListLicenseModeSchema
>;

export const chatMessageListCapabilitySchema = lazySchema(() =>
  z.discriminatedUnion("status", [
    z.discriminatedUnion("licenseMode", [
      z.object({
        status: z.literal("available"),
        provider: chatMessageListCapabilityProviderSchema,
        licenseMode: z.literal("licensed"),
        licenseKey: z.string().min(1),
      }),
      z.object({
        status: z.literal("available"),
        provider: chatMessageListCapabilityProviderSchema,
        licenseMode: z.literal("development-trial"),
        licenseKey: z.literal(""),
      }),
    ]),
    z.object({
      status: z.literal("unavailable"),
      provider: chatMessageListCapabilityProviderSchema,
      reason: runtimeCapabilityUnavailableReasonSchema,
    }),
  ]),
);
export type ChatMessageListCapability = z.infer<
  typeof chatMessageListCapabilitySchema
>;

export const runtimeCapabilitiesResponseSchema = lazySchema(() =>
  z.object({
    chatMessageList: chatMessageListCapabilitySchema,
  }),
);
export type RuntimeCapabilitiesResponse = z.infer<
  typeof runtimeCapabilitiesResponseSchema
>;
