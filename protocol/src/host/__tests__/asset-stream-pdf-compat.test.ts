/**
 * Compatibility proofs for the asset stream's 1.1 PDF addition.
 *
 * The 1.1 delta is a single widened enum literal (`application/pdf`) served
 * with `width`/`height: null` on the existing `assetHeader` frame. Each
 * minor registers its OWN server-frame schema so 1.0's released wire schema
 * stays frozen literally (the released-baseline compat gate diffs it), and
 * these tests pin the facts the mixed-version story rests on:
 *
 * 1. Every frame a 1.0 host could emit parses under BOTH minors' schemas
 *    (additivity in the direction old-host -> new-client).
 * 2. A PDF header parses under 1.1 and does NOT parse under 1.0 - which is
 *    why the host resolvers must gate admission and emission on the
 *    negotiated minor rather than trusting clients not to ask. If the
 *    rejection assertions ever start failing, the emission gate has become
 *    dead code and can be removed; until then it is load-bearing.
 * 3. The attachment channels (`epic.readChatAttachment`) stay image-only:
 *    their released response schema reuses the FROZEN 1.0 enum.
 */
import { describe, it, expect } from "vitest";
import {
  assetMediaTypeSchema,
  assetMediaTypeSchemaV11,
  assetStreamServerFrameSchema,
  assetStreamServerFrameSchemaV11,
} from "@traycer/protocol/host/asset-stream-schemas";
import {
  workspaceStreamAssetV10,
  workspaceStreamAssetV11,
} from "@traycer/protocol/host/workspace/asset-stream";
import {
  gitStreamFileAssetV10,
  gitStreamFileAssetV11,
} from "@traycer/protocol/host/git-asset-stream";
import { readChatAttachmentFoundSchema } from "@traycer/protocol/host/epic/chat-attachment";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";

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
  it("keeps the 1.0 enum frozen: no application/pdf", () => {
    expect(assetMediaTypeSchema.safeParse("application/pdf").success).toBe(
      false,
    );
    expect(assetMediaTypeSchemaV11.parse("application/pdf")).toBe(
      "application/pdf",
    );
  });

  it("parses a PDF assetHeader with null dimensions under the 1.1 schema", () => {
    const parsed = assetStreamServerFrameSchemaV11.parse(pdfHeaderFrame);
    expect(parsed).toEqual(pdfHeaderFrame);
  });

  it("parses every 1.0-era image header under BOTH minors' schemas", () => {
    // Old-host -> new-client direction: a not-yet-upgraded host emits
    // exactly these shapes, and the upgraded client parses with the
    // widened schema. Nothing a 1.0 host can produce may become invalid.
    const svgNullDims = {
      ...pngHeaderFrame,
      mediaType: "image/svg+xml" as const,
      width: null,
      height: null,
    };
    for (const frame of [pngHeaderFrame, svgNullDims]) {
      expect(assetStreamServerFrameSchema.parse(frame)).toEqual(frame);
      expect(assetStreamServerFrameSchemaV11.parse(frame)).toEqual(frame);
    }
  });

  it("REJECTS a PDF header under the 1.0 frame schema - the emission gate is load-bearing", () => {
    // This is the REGISTERED 1.0 schema, i.e. exactly what an un-upgraded
    // client's discriminated-union parse does with a leaked PDF header:
    // the whole frame fails, not just the field.
    expect(assetStreamServerFrameSchema.safeParse(pdfHeaderFrame).success).toBe(
      false,
    );
  });

  it("keeps the chat-attachment channel image-only", () => {
    const attachment = {
      ok: true as const,
      bytesBase64: "aGVsbG8=",
      mediaType: "application/pdf",
    };
    expect(readChatAttachmentFoundSchema.safeParse(attachment).success).toBe(
      false,
    );
    expect(
      readChatAttachmentFoundSchema.safeParse({
        ...attachment,
        mediaType: "image/png",
      }).success,
    ).toBe(true);
  });
});

describe("asset stream 1.1 registry wiring", () => {
  it("advertises latestMinor 1 on both methods", () => {
    expect(hostStreamRpcRegistry["workspace.streamAsset"][1].latestMinor).toBe(
      1,
    );
    expect(hostStreamRpcRegistry["git.streamFileAsset"][1].latestMinor).toBe(1);
  });

  it("registers the per-version frame schemas on the right minors", () => {
    // 1.0 keeps the frozen image-only schema; 1.1 registers the PDF-capable
    // one. The two methods share their frame schemas and move together.
    expect(workspaceStreamAssetV10.serverFrameSchema).toBe(
      assetStreamServerFrameSchema,
    );
    expect(workspaceStreamAssetV11.serverFrameSchema).toBe(
      assetStreamServerFrameSchemaV11,
    );
    expect(gitStreamFileAssetV10.serverFrameSchema).toBe(
      assetStreamServerFrameSchema,
    );
    expect(gitStreamFileAssetV11.serverFrameSchema).toBe(
      assetStreamServerFrameSchemaV11,
    );
    // The open request is version-invariant on both methods.
    expect(workspaceStreamAssetV10.openRequestSchema).toBe(
      workspaceStreamAssetV11.openRequestSchema,
    );
    expect(gitStreamFileAssetV10.openRequestSchema).toBe(
      gitStreamFileAssetV11.openRequestSchema,
    );
    expect(workspaceStreamAssetV11.schemaVersion).toEqual({
      major: 1,
      minor: 1,
    });
    expect(gitStreamFileAssetV11.schemaVersion).toEqual({ major: 1, minor: 1 });
  });
});
