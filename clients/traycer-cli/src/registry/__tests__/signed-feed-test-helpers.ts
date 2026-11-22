import {
  makeKey,
  makeSignatureFile,
  type GeneratedKey,
} from "./minisign-test-helpers";

export interface FeedSigningKey {
  readonly key: GeneratedKey;
  readonly keyId: string;
  readonly publicKeyText: string;
}

export function createFeedSigningKey(): FeedSigningKey {
  const key = makeKey();
  return {
    key,
    keyId: key.trustedPublicKey.keyId,
    publicKeyText: key.trustedPublicKey.raw,
  };
}

export function signFeedPayload(payload: string, key: FeedSigningKey): string {
  const signature = makeSignatureFile({
    message: Buffer.from(payload, "utf8"),
    key: key.key,
    trustedComment: "traycer signed-feed fixture",
    prehashed: true,
  });
  return JSON.stringify({ payload, keyId: key.keyId, signature });
}

export function feedPayload(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const now = Date.now();
  return {
    schemaVersion: 2,
    feed: "host",
    target: "production",
    policyRevision: 1,
    policyDigest: "a".repeat(64),
    generatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 90 * 24 * 60 * 60 * 1000).toISOString(),
    latest: "1.5.0",
    versions: [],
    ...overrides,
  };
}
