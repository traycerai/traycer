import { describe, expect, it } from "vitest";
import {
  upgradeRequestToVersion,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  FILE_ATTACHMENT_MAX_BASE64_LENGTH,
  FILE_ATTACHMENT_MAX_BYTES,
  draftsPutBlobRequestSchemaV11,
  draftsPutBlobRequestSchemaV12,
  draftsPutBlobResponseSchemaV12,
} from "@traycer/protocol/host/drafts/schemas";

const SHA256 = "a".repeat(64);

const FILE_PUT = {
  kind: "file" as const,
  sha256: SHA256,
  bytesBase64: "AQID",
  fileName: "clip.mov",
  mediaType: "video/quicktime",
};

describe("drafts.putBlob@1.2", () => {
  it("accepts a 16 MiB file and refuses a body over the file cap", () => {
    const sixteenMiB = Buffer.alloc(FILE_ATTACHMENT_MAX_BYTES).toString(
      "base64",
    );
    expect(
      draftsPutBlobRequestSchemaV12.safeParse({
        ...FILE_PUT,
        bytesBase64: sixteenMiB,
      }).success,
    ).toBe(true);
    expect(
      draftsPutBlobRequestSchemaV12.safeParse({
        ...FILE_PUT,
        bytesBase64: "A".repeat(FILE_ATTACHMENT_MAX_BASE64_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("keeps the image cap on an untagged put", () => {
    const sixteenMiB = Buffer.alloc(FILE_ATTACHMENT_MAX_BYTES).toString(
      "base64",
    );
    expect(
      draftsPutBlobRequestSchemaV12.safeParse({
        sha256: SHA256,
        bytesBase64: sixteenMiB,
      }).success,
    ).toBe(false);
  });

  it("refuses a file put without a file name", () => {
    const { fileName: _fileName, ...withoutName } = FILE_PUT;
    expect(draftsPutBlobRequestSchemaV12.safeParse(withoutName).success).toBe(
      false,
    );
  });

  it("upgrades a 1.1 put to an untagged 1.2 image put", () => {
    const request = draftsPutBlobRequestSchemaV11.parse({
      sha256: SHA256,
      bytesBase64: "AQID",
    });
    const upgraded = upgradeRequestToVersion(
      hostRpcRegistry["drafts.putBlob"],
      { major: 1, minor: 1 },
      { major: 1, minor: 2 },
      request,
    );
    expect(draftsPutBlobRequestSchemaV12.parse(upgraded)).toEqual({
      sha256: SHA256,
      bytesBase64: "AQID",
    });
  });

  it("upgrades a 1.1 success to a 1.2 success that names no path", () => {
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["drafts.putBlob"],
      { major: 1, minor: 1 },
      { major: 1, minor: 2 },
      { ok: true },
    );
    expect(draftsPutBlobResponseSchemaV12.parse(upgraded)).toEqual({
      ok: true,
    });
  });
});
