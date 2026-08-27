import { describe, expect, it } from "vitest";
import {
  splitConnectionManifest,
  SERVES_EVERY_INSTALLED_MAJOR,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { releasedMethodNames } from "@traycer/protocol/host/__tests__/__fixtures__/released-method-names";
import { assetMediaTypeSchema } from "@traycer/protocol/host/asset-stream-schemas";
import { imageSha256HexSchema } from "@traycer/protocol/persistence/epic/images";
import { epicFetchArtifactAttachmentV10 } from "@traycer/protocol/host/epic/contracts";
import {
  fetchArtifactAttachmentFoundSchema,
  fetchArtifactAttachmentRequestSchema,
  fetchArtifactAttachmentResponseSchema,
} from "@traycer/protocol/host/epic/artifact-attachment";

const METHOD = "epic.fetchArtifactAttachment";
const HASH = "ab".repeat(32);

describe("epic.fetchArtifactAttachment is optional, not floor", () => {
  it("is registered at 1.0 with an unsupported degrade", () => {
    expect(epicFetchArtifactAttachmentV10.method).toBe(METHOD);
    expect(epicFetchArtifactAttachmentV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(Object.hasOwn(hostRpcRegistry, METHOD)).toBe(true);
    expect(hostRpcRegistry[METHOD].degrade).toEqual({ kind: "unsupported" });
    expect(hostRpcRegistry[METHOD][1].latestMinor).toBe(0);
    expect(hostRpcRegistry[METHOD][1].versions[0]?.contract).toBe(
      epicFetchArtifactAttachmentV10,
    );
  });

  it("stays off the unary released floor and the frozen method-name fixture", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(METHOD);
    expect(releasedMethodNames).not.toContain(METHOD);
  });

  it("advertises on the optional manifest, not the floor manifest", () => {
    const split = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    expect(split.optionalManifest[METHOD]).toEqual({
      major: 1,
      minor: 0,
      supportedMajors: [1],
    });
    expect(split.manifest[METHOD]).toBeUndefined();
  });
});

describe("fetchArtifactAttachmentRequestSchema", () => {
  const request = {
    epicId: "epic-1",
    artifactId: "spec-1",
    hash: HASH,
  };

  it("requires epicId, artifactId, and a lowercase sha256 hex", () => {
    expect(fetchArtifactAttachmentRequestSchema.parse(request)).toEqual(
      request,
    );
    expect(fetchArtifactAttachmentRequestSchema.shape.hash).toBe(
      imageSha256HexSchema,
    );
  });

  it("rejects a hash-only request: the artifact is the authorization subject", () => {
    expect(
      fetchArtifactAttachmentRequestSchema.safeParse({ hash: HASH }).success,
    ).toBe(false);
    expect(
      fetchArtifactAttachmentRequestSchema.safeParse({
        epicId: "epic-1",
        hash: HASH,
      }).success,
    ).toBe(false);
    expect(
      fetchArtifactAttachmentRequestSchema.safeParse({
        artifactId: "spec-1",
        hash: HASH,
      }).success,
    ).toBe(false);
  });

  it("rejects empty ids and a non-canonical hash", () => {
    expect(
      fetchArtifactAttachmentRequestSchema.safeParse({
        ...request,
        epicId: "",
      }).success,
    ).toBe(false);
    expect(
      fetchArtifactAttachmentRequestSchema.safeParse({
        ...request,
        artifactId: "",
      }).success,
    ).toBe(false);
    expect(
      fetchArtifactAttachmentRequestSchema.safeParse({
        ...request,
        hash: HASH.toUpperCase(),
      }).success,
    ).toBe(false);
    expect(
      fetchArtifactAttachmentRequestSchema.safeParse({
        ...request,
        hash: HASH.slice(0, 63),
      }).success,
    ).toBe(false);
  });
});

describe("fetchArtifactAttachmentResponseSchema", () => {
  it("round-trips a found payload with the host-authoritative asset media type", () => {
    const found = {
      ok: true as const,
      bytesBase64: "AA==",
      mediaType: "image/png" as const,
    };
    expect(fetchArtifactAttachmentResponseSchema.parse(found)).toEqual(found);
    expect(fetchArtifactAttachmentFoundSchema.shape.mediaType).toBe(
      assetMediaTypeSchema,
    );
  });

  it("rejects a bytesBase64 that is not Base64 - the field contract is validated, not just documented", () => {
    expect(
      fetchArtifactAttachmentFoundSchema.safeParse({
        ok: true,
        bytesBase64: "not base64!",
        mediaType: "image/png",
      }).success,
    ).toBe(false);
    expect(
      fetchArtifactAttachmentFoundSchema.safeParse({
        ok: true,
        bytesBase64: "AA==",
        mediaType: "image/png",
      }).success,
    ).toBe(true);
  });

  it("round-trips missing as data, not as an RPC error, and collapses every absence reason", () => {
    const missing = { ok: false as const, reason: "missing" as const };
    expect(fetchArtifactAttachmentResponseSchema.parse(missing)).toEqual(
      missing,
    );
    expect(
      fetchArtifactAttachmentResponseSchema.safeParse({
        ok: false,
        reason: "forbidden",
      }).success,
    ).toBe(false);
    expect(
      fetchArtifactAttachmentResponseSchema.safeParse({
        ok: false,
        reason: "not-found",
      }).success,
    ).toBe(false);
  });

  it("rejects a found payload that omits mediaType or invents a renderer format", () => {
    expect(
      fetchArtifactAttachmentResponseSchema.safeParse({
        ok: true,
        bytesBase64: "AA==",
      }).success,
    ).toBe(false);
    expect(
      fetchArtifactAttachmentResponseSchema.safeParse({
        ok: true,
        bytesBase64: "AA==",
        mediaType: "image/avif",
      }).success,
    ).toBe(false);
    expect(
      fetchArtifactAttachmentResponseSchema.safeParse({
        ok: true,
        mediaType: "image/png",
      }).success,
    ).toBe(false);
  });

  it.each([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
  ] as const)("accepts asset-stream mediaType %s", (mediaType) => {
    const response = fetchArtifactAttachmentResponseSchema.parse({
      ok: true,
      bytesBase64: "AA==",
      mediaType,
    });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error("expected attachment bytes");
    expect(response.mediaType).toBe(mediaType);
  });
});
