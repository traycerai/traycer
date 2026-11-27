import { describe, expect, it } from "vitest";
import {
  splitConnectionManifest,
  SERVES_EVERY_INSTALLED_MAJOR,
  validateVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { releasedMethodNames } from "@traycer/protocol/host/__tests__/__fixtures__/released-method-names";
import { assetMediaTypeSchema } from "@traycer/protocol/host/asset-stream-schemas";
import { imageSha256HexSchema } from "@traycer/protocol/persistence/epic/images";
import {
  epicFetchArtifactAttachmentUpgradeV10ToV11,
  epicFetchArtifactAttachmentV10,
  epicFetchArtifactAttachmentV11,
} from "@traycer/protocol/host/epic/contracts";
import {
  fetchArtifactAttachmentFoundSchema,
  fetchArtifactAttachmentRequestSchema,
  fetchArtifactAttachmentResponseSchema,
  projectEpicFetchArtifactAttachmentResponseToV10,
} from "@traycer/protocol/host/epic/artifact-attachment";

const METHOD = "epic.fetchArtifactAttachment";
const HASH = "ab".repeat(32);

describe("epic.fetchArtifactAttachment is optional, not floor", () => {
  it("is registered at 1.1, growing from 1.0, with an unsupported degrade", () => {
    expect(epicFetchArtifactAttachmentV10.method).toBe(METHOD);
    expect(epicFetchArtifactAttachmentV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(Object.hasOwn(hostRpcRegistry, METHOD)).toBe(true);
    expect(hostRpcRegistry[METHOD].degrade).toEqual({ kind: "unsupported" });
    expect(hostRpcRegistry[METHOD][1].latestMinor).toBe(1);
    expect(hostRpcRegistry[METHOD][1].versions[0]?.contract).toBe(
      epicFetchArtifactAttachmentV10,
    );
    expect(hostRpcRegistry[METHOD][1].versions[1]?.contract).toBe(
      epicFetchArtifactAttachmentV11,
    );
    expect(
      hostRpcRegistry[METHOD][1].versions[1]?.upgradeFromPreviousVersion,
    ).toBe(epicFetchArtifactAttachmentUpgradeV10ToV11);
    expect(
      hostRpcRegistry[METHOD][1].versions[1]?.responseGrowthProjectionGated,
    ).toBe(true);
  });

  it("passes registry validation with the 1.1 response growth", () => {
    expect(() =>
      validateVersionedRpcRegistry({
        "epic.fetchArtifactAttachment":
          hostRpcRegistry["epic.fetchArtifactAttachment"],
      }),
    ).not.toThrow();
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
      minor: 1,
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

describe("the downloading answer", () => {
  const downloading = {
    ok: false as const,
    reason: "downloading" as const,
    receivedBytes: 4,
    totalBytes: 10,
  };

  it.each([
    { receivedBytes: 0, totalBytes: 0 },
    { receivedBytes: 4, totalBytes: 10 },
    { receivedBytes: 10, totalBytes: 10 },
  ])(
    "is accepted at 1.1 with $receivedBytes of $totalBytes bytes",
    (progress) => {
      const answer = { ...downloading, ...progress };
      expect(
        epicFetchArtifactAttachmentV11.responseSchema.parse(answer),
      ).toEqual(answer);
    },
  );

  it.each([
    { name: "more bytes received than the total", receivedBytes: 11 },
    { name: "a negative received count", receivedBytes: -1 },
    { name: "a fractional received count", receivedBytes: 1.5 },
    { name: "a fractional total", totalBytes: 10.5 },
  ])("is rejected at 1.1 with $name", ({ name: _name, ...progress }) => {
    expect(
      epicFetchArtifactAttachmentV11.responseSchema.safeParse({
        ...downloading,
        ...progress,
      }).success,
    ).toBe(false);
  });

  it("is rejected by the frozen 1.0 response schema", () => {
    expect(
      epicFetchArtifactAttachmentV10.responseSchema.safeParse(downloading)
        .success,
    ).toBe(false);
  });

  it("is served to a 1.0 caller as exactly missing", () => {
    expect(
      projectEpicFetchArtifactAttachmentResponseToV10(downloading),
    ).toStrictEqual({ ok: false, reason: "missing" });
  });

  it.each([
    { ok: true as const, bytesBase64: "AA==", mediaType: "image/png" as const },
    { ok: false as const, reason: "missing" as const },
  ])("leaves a 1.0-shaped answer (ok: $ok) as it was", (answer) => {
    expect(
      projectEpicFetchArtifactAttachmentResponseToV10({ ...answer }),
    ).toStrictEqual(answer);
  });
});
