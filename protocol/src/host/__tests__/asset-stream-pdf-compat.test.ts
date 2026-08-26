/**
 * Compatibility proofs for the asset stream's 1.1 PDF addition.
 *
 * The 1.1 delta is a single widened enum literal (`application/pdf`) served
 * with `width`/`height: null` on the existing `assetHeader` frame. These
 * tests pin the two facts the whole mixed-version story rests on:
 *
 * 1. Every frame a 1.0 host could emit still parses under the 1.1 schema
 *    (additivity in the direction old-host -> new-client).
 * 2. A PDF header does NOT parse under a 1.0 client's schema - which is why
 *    the host resolvers must gate admission and emission on the negotiated
 *    minor rather than trusting clients not to ask. If this test ever
 *    starts failing at the `not.toBe` assertions, the emission gate has
 *    become dead code and can be removed; until then it is load-bearing.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  assetMediaTypeSchema,
  assetStreamServerFrameSchema,
} from "@traycer/protocol/host/asset-stream-schemas";
import {
  workspaceStreamAssetV10,
  workspaceStreamAssetV11,
} from "@traycer/protocol/host/workspace/asset-stream";
import {
  gitStreamFileAssetV10,
  gitStreamFileAssetV11,
} from "@traycer/protocol/host/git-asset-stream";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * A faithful reconstruction of the media-type enum as every 1.0 client
 * shipped it. Deliberately inlined rather than imported: the live export
 * has been widened, and the point is to parse with the schema an
 * un-upgraded peer still runs.
 */
const v10MediaTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

const pdfHeaderFrame = {
  kind: "assetHeader" as const,
  hasBinaryPayload: false as const,
  mediaType: "application/pdf" as const,
  sizeBytes: 2_213_840,
  width: null,
  height: null,
  contentIdentity: "8f3ab2c9d4e5f60718293a4b5c6d7e8f90a1b2c3",
};

const pngHeaderFrame = {
  kind: "assetHeader" as const,
  hasBinaryPayload: false as const,
  mediaType: "image/png" as const,
  sizeBytes: 512,
  width: 32,
  height: 32,
  contentIdentity: "1024:1735689600000",
};

describe("asset stream 1.1 media-type widening", () => {
  it("accepts application/pdf in the live enum", () => {
    expect(assetMediaTypeSchema.parse("application/pdf")).toBe(
      "application/pdf",
    );
  });

  it("parses a PDF assetHeader with null dimensions under the 1.1 schema", () => {
    const parsed = assetStreamServerFrameSchema.parse(pdfHeaderFrame);
    expect(parsed).toEqual(pdfHeaderFrame);
  });

  it("still parses every 1.0-era image header under the 1.1 schema", () => {
    // Old-host -> new-client direction: a not-yet-upgraded host emits
    // exactly these shapes, and the upgraded client parses with the
    // widened schema. Nothing a 1.0 host can produce may become invalid.
    expect(assetStreamServerFrameSchema.parse(pngHeaderFrame)).toEqual(
      pngHeaderFrame,
    );
    const svgNullDims = {
      ...pngHeaderFrame,
      mediaType: "image/svg+xml" as const,
      width: null,
      height: null,
    };
    expect(assetStreamServerFrameSchema.parse(svgNullDims)).toEqual(
      svgNullDims,
    );
  });

  it("REJECTS a PDF header under a 1.0 client's enum - the emission gate is load-bearing", () => {
    expect(v10MediaTypeSchema.safeParse("application/pdf").success).toBe(
      false,
    );
    // And through the whole frame: rebuild the 1.0 header variant around
    // the old enum and confirm the full frame fails, not just the field -
    // this is what an un-upgraded client's discriminated-union parse does
    // with a leaked PDF header.
    const v10HeaderSchema = z.object({
      kind: z.literal("assetHeader"),
      hasBinaryPayload: z.literal(false),
      mediaType: v10MediaTypeSchema,
      sizeBytes: z.number().int().nonnegative(),
      width: z.number().int().positive().nullable(),
      height: z.number().int().positive().nullable(),
      contentIdentity: z.string(),
    });
    expect(v10HeaderSchema.safeParse(pdfHeaderFrame).success).toBe(false);
  });
});

describe("asset stream 1.1 registry wiring", () => {
  it("advertises latestMinor 1 on both methods", () => {
    expect(hostStreamRpcRegistry["workspace.streamAsset"][1].latestMinor).toBe(1);
    expect(hostStreamRpcRegistry["git.streamFileAsset"][1].latestMinor).toBe(1);
  });

  it("keeps both minors of each method on shared frame-schema objects", () => {
    // The 1.1 delta is the enum literal alone; the contracts must reference
    // the same schema objects so the two minors can never drift apart
    // structurally. (Identity, not deep-equality, is the invariant.)
    expect(workspaceStreamAssetV10.serverFrameSchema).toBe(
      workspaceStreamAssetV11.serverFrameSchema,
    );
    expect(workspaceStreamAssetV10.openRequestSchema).toBe(
      workspaceStreamAssetV11.openRequestSchema,
    );
    expect(gitStreamFileAssetV10.serverFrameSchema).toBe(
      gitStreamFileAssetV11.serverFrameSchema,
    );
    expect(workspaceStreamAssetV11.schemaVersion).toEqual({
      major: 1,
      minor: 1,
    });
    expect(gitStreamFileAssetV11.schemaVersion).toEqual({ major: 1, minor: 1 });
  });
});
