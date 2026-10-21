import { z } from "zod";

import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/** Largest text answer an artifact-object read gives. */
export const EPIC_READ_ARTIFACT_OBJECT_TEXT_MAX_BYTES = 25 * 1024 * 1024;
/** Largest byte span one range read may ask for. */
export const EPIC_READ_ARTIFACT_OBJECT_RANGE_MAX_BYTES = 4 * 1024 * 1024;

/** Lowercase hex sha256, the content address written by the object store. */
const artifactObjectSha256Schema = lazySchema(() =>
  z.string().regex(/^[0-9a-f]{64}$/),
);

/** The host decides which network requests the rendered object may make. */
export const artifactObjectNetworkPolicySchema = lazySchema(() =>
  z.enum(["open", "https-only"]),
);
export type ArtifactObjectNetworkPolicy = z.infer<
  typeof artifactObjectNetworkPolicySchema
>;

export const epicReadArtifactObjectWantSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text") }),
    z.object({
      kind: z.literal("range"),
      offset: z.number().int().nonnegative(),
      length: z
        .number()
        .int()
        .positive()
        .max(EPIC_READ_ARTIFACT_OBJECT_RANGE_MAX_BYTES),
    }),
    z.object({ kind: z.literal("url") }),
  ]),
);
export type EpicReadArtifactObjectWant = z.infer<
  typeof epicReadArtifactObjectWantSchema
>;

/** A sha-addressed read authorised by an artifact head or stamped chat row. */
export const epicReadArtifactObjectRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    sha256: artifactObjectSha256Schema,
    want: epicReadArtifactObjectWantSchema,
  }),
);
export type EpicReadArtifactObjectRequest = z.infer<
  typeof epicReadArtifactObjectRequestSchema
>;

/**
 * For an authorised sha absent from its store, the host starts an on-demand
 * cloud download and waits up to 3 s before answering `downloading`. The caller
 * asks again until another arm comes back. Spans are served only once the whole
 * object is on disk. Authorisation requires the sha in an artifact head or a
 * stamped chat row.
 */
export const epicReadArtifactObjectResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("text"),
      text: z.string(),
      mediaType: z.string(),
      networkPolicy: artifactObjectNetworkPolicySchema,
    }),
    z.object({
      kind: z.literal("bytes"),
      /** Base64 of the raw bytes from `offset` - see `epic.readChatAttachment`. */
      bytesBase64: z.string(),
      offset: z.number().int().nonnegative(),
      totalBytes: z.number().int().nonnegative(),
      mediaType: z.string(),
    }),
    z.object({
      kind: z.literal("url"),
      url: z.string().url(),
      /** Epoch ms. The client renews at 80 % of the lifetime. */
      expiresAt: z.number(),
    }),
    z.object({
      kind: z.literal("unavailable"),
      reason: z.enum(["missing", "not-downloaded", "failed"]),
    }),
    z
      .object({
        kind: z.literal("downloading"),
        receivedBytes: z.number().int().nonnegative(),
        totalBytes: z.number().int().nonnegative(),
      })
      .refine((progress) => progress.receivedBytes <= progress.totalBytes, {
        message: "Received bytes must not exceed total bytes",
        path: ["receivedBytes"],
      }),
  ]),
);
export type EpicReadArtifactObjectResponse = z.infer<
  typeof epicReadArtifactObjectResponseSchema
>;
export const epicReadArtifactObjectV10 = defineRpcContract({
  method: "epic.readArtifactObject",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: epicReadArtifactObjectRequestSchema,
  responseSchema: epicReadArtifactObjectResponseSchema,
});
