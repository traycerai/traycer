import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { signGcsReadUrl } from "../gcs-signed-url";

/*
 * The vector was computed once by hand, outside the module: the canonical
 * request below, hashed with `printf ... | shasum -a 256` (no trailing newline),
 * is the digest on the string to sign's last line.
 */
const CLIENT_EMAIL = "signer@example-project.iam.gserviceaccount.com";
const NOW_MS = Date.UTC(2026, 10, 3, 4, 5, 6);
const OBJECT_NAME = "sets/team/my track!'()*.opus";

const PATH = "/bucket-x/sets/team/my%20track%21%27%28%29%2A.opus";
const QUERY =
  "X-Goog-Algorithm=GOOG4-RSA-SHA256" +
  "&X-Goog-Credential=signer%40example-project.iam.gserviceaccount.com%2F20261103%2Fauto%2Fstorage%2Fgoog4_request" +
  "&X-Goog-Date=20261103T040506Z" +
  "&X-Goog-Expires=3600" +
  "&X-Goog-SignedHeaders=host";

const CANONICAL_REQUEST = [
  "GET",
  PATH,
  QUERY,
  "host:storage.googleapis.com",
  "",
  "host",
  "UNSIGNED-PAYLOAD",
].join("\n");

const STRING_TO_SIGN = [
  "GOOG4-RSA-SHA256",
  "20261103T040506Z",
  "20261103/auto/storage/goog4_request",
  "2b21f5e071c73bd4409c76bde528603d80b4ca8a9eb2c6946f49baafa20ed3fc",
].join("\n");

let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKeyPem = pair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  publicKeyPem = pair.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
});

function signed(): string {
  return signGcsReadUrl(
    {
      clientEmail: CLIENT_EMAIL,
      privateKey: privateKeyPem,
      privateKeyId: null,
    },
    "bucket-x",
    OBJECT_NAME,
    NOW_MS,
  );
}

describe("signGcsReadUrl", () => {
  it("writes the path and query exactly, encoding the object name and the credential", () => {
    const url = signed();

    const signatureAt = url.lastIndexOf("&X-Goog-Signature=");
    expect(url.slice(0, signatureAt)).toBe(
      `https://storage.googleapis.com${PATH}?${QUERY}`,
    );
    expect(url.slice(signatureAt + "&X-Goog-Signature=".length)).toMatch(
      /^[0-9a-f]{512}$/,
    );
  });

  it("signs the pinned string to sign, which hashes the pinned canonical request", () => {
    const url = signed();
    const signature = url.slice(url.lastIndexOf("=") + 1);

    expect(createHash("sha256").update(CANONICAL_REQUEST).digest("hex")).toBe(
      STRING_TO_SIGN.split("\n")[3],
    );
    expect(
      createVerify("RSA-SHA256")
        .update(STRING_TO_SIGN)
        .verify(publicKeyPem, signature, "hex"),
    ).toBe(true);
  });
});
