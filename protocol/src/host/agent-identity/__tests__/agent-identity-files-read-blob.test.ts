import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  AGENT_IDENTITY_UPLOAD_MAX_CHUNK_BYTES,
  agentIdentityFilesReadBlobRequestSchema,
  agentIdentityFilesReadBlobResponseSchema,
} from "@traycer/protocol/host/agent-identity/unary-schemas";

/**
 * `agentIdentity.files.readBlob@1.0` - the read half of `files.uploadBlob`.
 *
 * Pins the four facts a host and a GUI written against this contract have to
 * agree on: the object is named by sha, a chunk is capped at the upload chunk,
 * `pending` is a bare answer the caller retries, and the refusal is the family's
 * shared arm.
 */

const SHA = "a".repeat(64);

const REQUEST = {
  identityId: "identity_1",
  path: "skills/a/logo.png",
  sha256: SHA,
  offset: 0,
  length: AGENT_IDENTITY_UPLOAD_MAX_CHUNK_BYTES,
};

describe("agentIdentityFilesReadBlobRequestSchema", () => {
  it("parses a read of one whole chunk", () => {
    expect(agentIdentityFilesReadBlobRequestSchema.parse(REQUEST)).toEqual(
      REQUEST,
    );
  });

  it("requires the sha, so a multi-chunk read cannot splice two objects", () => {
    const { sha256: _omitted, ...withoutSha } = REQUEST;
    expect(
      agentIdentityFilesReadBlobRequestSchema.safeParse(withoutSha).success,
    ).toBe(false);
  });

  it("caps a chunk at the upload chunk and refuses an empty one", () => {
    for (const length of [AGENT_IDENTITY_UPLOAD_MAX_CHUNK_BYTES + 1, 0, -1]) {
      expect(
        agentIdentityFilesReadBlobRequestSchema.safeParse({
          ...REQUEST,
          length,
        }).success,
      ).toBe(false);
    }
  });

  it("refuses a negative offset", () => {
    expect(
      agentIdentityFilesReadBlobRequestSchema.safeParse({
        ...REQUEST,
        offset: -1,
      }).success,
    ).toBe(false);
  });
});

describe("agentIdentityFilesReadBlobResponseSchema", () => {
  it("parses a chunk, carrying the whole object's length", () => {
    const chunk = {
      kind: "ok",
      bytesBase64: "AQID",
      byteLength: 1_000_000,
      mediaType: "image/png",
      final: false,
    };
    expect(agentIdentityFilesReadBlobResponseSchema.parse(chunk)).toEqual(
      chunk,
    );
  });

  it("parses the empty final chunk of a zero-length blob", () => {
    expect(
      agentIdentityFilesReadBlobResponseSchema.safeParse({
        kind: "ok",
        bytesBase64: "",
        byteLength: 0,
        mediaType: "application/octet-stream",
        final: true,
      }).success,
    ).toBe(true);
  });

  it("parses a bare pending answer", () => {
    expect(
      agentIdentityFilesReadBlobResponseSchema.parse({ kind: "pending" }),
    ).toEqual({ kind: "pending" });
  });

  it("refuses with the family's shared reasons", () => {
    for (const reason of [
      "pathNotFound",
      "unsupportedBodyKind",
      "identityNotFound",
      "projectionUnavailable",
    ]) {
      expect(
        agentIdentityFilesReadBlobResponseSchema.safeParse({
          kind: "refused",
          reason,
          detail: "",
        }).success,
      ).toBe(true);
    }
  });
});

describe("agentIdentity.files.readBlob registration", () => {
  it("is an optional 1.0 method, hidden against an older host", () => {
    const entry = hostRpcRegistry["agentIdentity.files.readBlob"];
    expect(entry.degrade).toEqual({ kind: "unsupported" });
    expect(entry[1].latestMinor).toBe(0);
    expect(entry[1].versions[0].contract.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
  });
});
