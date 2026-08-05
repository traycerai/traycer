#!/usr/bin/env python3
from __future__ import annotations

import re
import sys
from pathlib import Path


def main() -> None:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()

    identity = root / "protocol/src/config/local-identity.ts"
    text = identity.read_text()
    text = text.replace("  type JsonWebKey,\n", "")
    text = re.sub(
        r"(?:type|interface) LocalJsonWebKey[^\n]*(?:\n\s*readonly kid\?: string;\n\})?\n\n",
        "",
        text,
        count=1,
    )
    text = text.replace(
        "function publicJwkFromPrivateKey(privateKeyPem: string): JsonWebKey {",
        "function publicJwkFromPrivateKey(privateKeyPem: string) {",
    )
    text = text.replace("  }) as JsonWebKey;", "  });")

    start = text.find("export async function validateLocalToken(")
    if start < 0:
        raise SystemExit("validateLocalToken function was not found")
    replacement = '''export async function validateLocalToken(
  token: string,
): Promise<LocalAuthValidationResult> {
  const [headerSegment, payloadSegment, signatureSegment, extra] = token.split(".");
  if (
    headerSegment === undefined ||
    payloadSegment === undefined ||
    signatureSegment === undefined ||
    extra !== undefined
  ) {
    return { kind: "rejected" };
  }
  const header = decodeJsonSegment(headerSegment);
  const payload = decodeJsonSegment(payloadSegment);
  if (
    header?.alg !== "RS256" ||
    header.kid !== LOCAL_IDENTITY_KEY_ID ||
    payload?.id !== LOCAL_USER_ID ||
    payload.sub !== LOCAL_USER_ID ||
    payload.aud !== LOCAL_TOKEN_AUDIENCE ||
    payload.iss !== LOCAL_TOKEN_ISSUER ||
    typeof payload.exp !== "number" ||
    payload.exp <= Math.floor(Date.now() / 1000)
  ) {
    return { kind: "rejected" };
  }
  try {
    const privateKey = await readFile(localIdentityPaths().privateKey, "utf8");
    const valid = createVerify("RSA-SHA256")
      .update(`${headerSegment}.${payloadSegment}`)
      .end()
      .verify(
        createPublicKey(createPrivateKey(privateKey)),
        Buffer.from(signatureSegment, "base64url"),
      );
    return valid
      ? { kind: "valid", user: localAuthenticatedUser() }
      : { kind: "rejected" };
  } catch {
    return { kind: "rejected" };
  }
}
'''
    identity.write_text(text[:start] + replacement)

    analytics = root / "clients/gui-app/src/lib/analytics.ts"
    text = analytics.read_text()
    text = re.sub(
        r"^\s*private readonly key: string \| undefined;\n",
        "",
        text,
        count=1,
        flags=re.MULTILINE,
    )
    text = text.replace("    this.key = key;\n", "    void key;\n", 1)
    text = text.replace("    this.key = undefined;\n", "")
    analytics.write_text(text)

    print("Accountless compatibility rewrite applied")


if __name__ == "__main__":
    main()
