/**
 * Compatibility proofs for the asset stream's document additions - PDF in 1.1
 * and Word `.docx` in 1.2.
 *
 * Each delta is a single widened enum literal (`application/pdf`, then the
 * OOXML WordprocessingML type) served with `width`/`height: null` on the
 * existing `assetHeader` frame. Each minor registers its OWN server-frame
 * schema so a released minor's wire schema stays frozen literally (the
 * released-baseline compat gate diffs it), and these tests pin the facts the
 * mixed-version story rests on:
 *
 * 1. Every frame an older host could emit parses under EVERY later minor's
 *    schema (additivity in the direction old-host -> new-client).
 * 2. A PDF header parses under 1.1 and not 1.0; a `.docx` header parses under
 *    1.2 and neither 1.1 nor 1.0 - which is why the host resolvers must gate
 *    admission and emission on the negotiated minor rather than trusting
 *    clients not to ask. If the rejection assertions ever start failing, the
 *    emission gate has become dead code and can be removed; until then it is
 *    load-bearing.
 * 3. The attachment channels (`epic.readChatAttachment`) stay image-only:
 *    their released response schema reuses the FROZEN 1.0 enum, so neither
 *    document type is admissible there.
 */
import { describe, it, expect } from "vitest";
import {
  DOCX_MEDIA_TYPE,
  assetMediaTypeSchema,
  assetMediaTypeSchemaV11,
  assetMediaTypeSchemaV12,
  assetStreamServerFrameSchema,
  assetStreamServerFrameSchemaV11,
  assetStreamServerFrameSchemaV12,
} from "@traycer/protocol/host/asset-stream-schemas";
import {
  workspaceStreamAssetV10,
  workspaceStreamAssetV11,
  workspaceStreamAssetV12,
} from "@traycer/protocol/host/workspace/asset-stream";
import {
  gitStreamFileAssetV10,
  gitStreamFileAssetV11,
  gitStreamFileAssetV12,
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

const docxHeaderFrame = {
  kind: "assetHeader" as const,
  hasBinaryPayload: false as const,
  mediaType: DOCX_MEDIA_TYPE,
  sizeBytes: 41_216,
  width: null,
  height: null,
  contentIdentity: "c1d2e3f4a5b60718293a4b5c6d7e8f90a1b2c3d4",
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

const svgNullDimsHeaderFrame = {
  ...pngHeaderFrame,
  mediaType: "image/svg+xml" as const,
  width: null,
  height: null,
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
    for (const frame of [pngHeaderFrame, svgNullDimsHeaderFrame]) {
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

describe("asset stream 1.2 media-type widening", () => {
  it("keeps the 1.0 and 1.1 enums frozen: no Word media type", () => {
    expect(assetMediaTypeSchema.safeParse(DOCX_MEDIA_TYPE).success).toBe(false);
    expect(assetMediaTypeSchemaV11.safeParse(DOCX_MEDIA_TYPE).success).toBe(
      false,
    );
    expect(assetMediaTypeSchemaV12.parse(DOCX_MEDIA_TYPE)).toBe(
      DOCX_MEDIA_TYPE,
    );
  });

  it("spells the Word media type as the OOXML WordprocessingML type", () => {
    // The constant is what the host's extension map, the client's viewer
    // routing and the 1.2 enum all share - pinning the literal here keeps a
    // typo from silently becoming the wire value.
    expect(DOCX_MEDIA_TYPE).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("parses a Word assetHeader with null dimensions under the 1.2 schema", () => {
    const parsed = assetStreamServerFrameSchemaV12.parse(docxHeaderFrame);
    expect(parsed).toEqual(docxHeaderFrame);
  });

  it("parses every 1.1-era header under the 1.2 schema", () => {
    // The backward-compatibility guarantee: everything a 1.0 or 1.1 host can
    // emit - images with dimensions, dimensionless SVGs, PDFs - still parses
    // once the client upgrades its parser to 1.2.
    for (const frame of [
      pngHeaderFrame,
      svgNullDimsHeaderFrame,
      pdfHeaderFrame,
    ]) {
      expect(assetStreamServerFrameSchemaV12.parse(frame)).toEqual(frame);
    }
  });

  it("parses the version-invariant non-header frames under the 1.2 schema", () => {
    // Only the header's media type moves between minors; the chunk,
    // completion, error and pong arms are shared schema objects and must keep
    // round-tripping unchanged.
    const otherFrames = [
      {
        kind: "assetChunk" as const,
        hasBinaryPayload: true as const,
        index: 0,
        byteLength: 65_536,
      },
      { kind: "assetComplete" as const, hasBinaryPayload: false as const },
      {
        kind: "assetError" as const,
        hasBinaryPayload: false as const,
        error: "unsupported asset type",
        reason: "not-image" as const,
      },
      { kind: "pong" as const, hasBinaryPayload: false as const },
    ];
    for (const frame of otherFrames) {
      expect(assetStreamServerFrameSchema.parse(frame)).toEqual(frame);
      expect(assetStreamServerFrameSchemaV11.parse(frame)).toEqual(frame);
      expect(assetStreamServerFrameSchemaV12.parse(frame)).toEqual(frame);
    }
  });

  it("REJECTS a Word header under the 1.0 and 1.1 frame schemas - the emission gate is load-bearing", () => {
    // A leaked `.docx` header fails the whole discriminated-union parse on
    // every client whose parser predates 1.2, which is what obliges the host
    // resolvers to gate emission on the negotiated minor.
    expect(
      assetStreamServerFrameSchema.safeParse(docxHeaderFrame).success,
    ).toBe(false);
    expect(
      assetStreamServerFrameSchemaV11.safeParse(docxHeaderFrame).success,
    ).toBe(false);
  });

  it("keeps the chat-attachment channel image-only for Word documents too", () => {
    expect(
      readChatAttachmentFoundSchema.safeParse({
        ok: true as const,
        bytesBase64: "aGVsbG8=",
        mediaType: DOCX_MEDIA_TYPE,
      }).success,
    ).toBe(false);
  });
});

describe("asset stream registry wiring", () => {
  it("advertises latestMinor 2 on both methods", () => {
    expect(hostStreamRpcRegistry["workspace.streamAsset"][1].latestMinor).toBe(
      2,
    );
    expect(hostStreamRpcRegistry["git.streamFileAsset"][1].latestMinor).toBe(2);
  });

  it("registers the per-version frame schemas on the right minors", () => {
    // 1.0 keeps the frozen image-only schema; 1.1 registers the PDF-capable
    // one and 1.2 the Word-capable one. The two methods share their frame
    // schemas and move minors together.
    expect(workspaceStreamAssetV10.serverFrameSchema).toBe(
      assetStreamServerFrameSchema,
    );
    expect(workspaceStreamAssetV11.serverFrameSchema).toBe(
      assetStreamServerFrameSchemaV11,
    );
    expect(workspaceStreamAssetV12.serverFrameSchema).toBe(
      assetStreamServerFrameSchemaV12,
    );
    expect(gitStreamFileAssetV10.serverFrameSchema).toBe(
      assetStreamServerFrameSchema,
    );
    expect(gitStreamFileAssetV11.serverFrameSchema).toBe(
      assetStreamServerFrameSchemaV11,
    );
    expect(gitStreamFileAssetV12.serverFrameSchema).toBe(
      assetStreamServerFrameSchemaV12,
    );
    // The open request is version-invariant on both methods.
    expect(workspaceStreamAssetV10.openRequestSchema).toBe(
      workspaceStreamAssetV11.openRequestSchema,
    );
    expect(workspaceStreamAssetV11.openRequestSchema).toBe(
      workspaceStreamAssetV12.openRequestSchema,
    );
    expect(gitStreamFileAssetV10.openRequestSchema).toBe(
      gitStreamFileAssetV11.openRequestSchema,
    );
    expect(gitStreamFileAssetV11.openRequestSchema).toBe(
      gitStreamFileAssetV12.openRequestSchema,
    );
    expect(workspaceStreamAssetV11.schemaVersion).toEqual({
      major: 1,
      minor: 1,
    });
    expect(gitStreamFileAssetV11.schemaVersion).toEqual({ major: 1, minor: 1 });
    expect(workspaceStreamAssetV12.schemaVersion).toEqual({
      major: 1,
      minor: 2,
    });
    expect(gitStreamFileAssetV12.schemaVersion).toEqual({ major: 1, minor: 2 });
  });

  it("registers the 1.2 contracts on minor 2 of both methods", () => {
    expect(
      hostStreamRpcRegistry["workspace.streamAsset"][1].versions[2]?.contract,
    ).toBe(workspaceStreamAssetV12);
    expect(
      hostStreamRpcRegistry["git.streamFileAsset"][1].versions[2]?.contract,
    ).toBe(gitStreamFileAssetV12);
  });
});
