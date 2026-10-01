import { describe, expect, it } from "vitest";
import {
  DRAFT_BLOB_MAX_BASE64_LENGTH,
  draftsPutBlobRequestSchema,
  draftsPutBlobRequestSchemaV11,
  draftsReadBlobRequestSchema,
  draftsReadBlobResponseSchema,
  draftsReadBlobResponseSchemaV11,
} from "@traycer/protocol/host/drafts/schemas";
import {
  draftsReadBlobV10,
  draftsReadBlobV11,
} from "@traycer/protocol/host/drafts/contracts";

const SHA256 = "a".repeat(64);

function base64Of(length: number): string {
  return "A".repeat(length);
}

describe("drafts.putBlob wire cap", () => {
  it("draftsPutBlobRequestSchemaV11 accepts exactly the cap", () => {
    const atCap = {
      sha256: SHA256,
      bytesBase64: base64Of(DRAFT_BLOB_MAX_BASE64_LENGTH),
    };
    expect(draftsPutBlobRequestSchemaV11.safeParse(atCap).success).toBe(true);
  });

  it("draftsPutBlobRequestSchemaV11 rejects one character over the cap", () => {
    const overCap = {
      sha256: SHA256,
      bytesBase64: base64Of(DRAFT_BLOB_MAX_BASE64_LENGTH + 1),
    };
    expect(draftsPutBlobRequestSchemaV11.safeParse(overCap).success).toBe(
      false,
    );
  });

  it("draftsPutBlobRequestSchema (1.0) accepts the over-cap value unchanged", () => {
    const overCap = {
      sha256: SHA256,
      bytesBase64: base64Of(DRAFT_BLOB_MAX_BASE64_LENGTH + 1),
    };
    expect(draftsPutBlobRequestSchema.parse(overCap)).toEqual(overCap);
  });
});

describe("drafts.readBlob wire cap", () => {
  it("draftsReadBlobResponseSchemaV11 rejects an over-cap ok:true body", () => {
    const overCap = {
      ok: true as const,
      bytesBase64: base64Of(DRAFT_BLOB_MAX_BASE64_LENGTH + 1),
    };
    expect(draftsReadBlobResponseSchemaV11.safeParse(overCap).success).toBe(
      false,
    );
  });

  it("draftsReadBlobResponseSchemaV11 accepts exactly the cap", () => {
    const atCap = {
      ok: true as const,
      bytesBase64: base64Of(DRAFT_BLOB_MAX_BASE64_LENGTH),
    };
    expect(draftsReadBlobResponseSchemaV11.safeParse(atCap).success).toBe(true);
  });

  it("draftsReadBlobResponseSchema (1.0) accepts the over-cap ok:true body", () => {
    const overCap = {
      ok: true as const,
      bytesBase64: base64Of(DRAFT_BLOB_MAX_BASE64_LENGTH + 1),
    };
    expect(draftsReadBlobResponseSchema.parse(overCap)).toEqual(overCap);
  });

  it("draftsReadBlobResponseSchemaV11 still accepts the ok:false arm unchanged", () => {
    expect(
      draftsReadBlobResponseSchemaV11.safeParse({
        ok: false,
        reason: "missing",
      }).success,
    ).toBe(true);
  });

  it("drafts.readBlob@1.1 reuses the 1.0 request instance - its request carries only a digest", () => {
    expect(draftsReadBlobV11.requestSchema).toBe(draftsReadBlobRequestSchema);
    expect(draftsReadBlobV10.requestSchema).toBe(draftsReadBlobRequestSchema);
  });
});
