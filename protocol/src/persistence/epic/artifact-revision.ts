import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * The kinds of object-backed artifact whose head the cloud's revision chain
 * arbitrates. One chain per artifact, of one kind: every chain request names
 * the kind, and every revision envelope carries it as its discriminator, so a
 * reader never takes one kind's envelope for another's.
 */
export const artifactRevisionKindSchema = lazySchema(() =>
  z.enum(["markdown"]),
);
export type ArtifactRevisionKind = z.infer<typeof artifactRevisionKindSchema>;
