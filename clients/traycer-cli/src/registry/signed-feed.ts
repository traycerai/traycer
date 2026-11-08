import { randomUUID } from "node:crypto";
import { readFile, rename, rm, open } from "node:fs/promises";
import { join } from "node:path";
import { withCliScopedFileLock } from "../store/cli-lock";
import {
  config,
  releaseFeedTarget,
  signedFeedUrls,
  type ReleaseFeed,
} from "../config";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import { cliSharedHomeDir, ensurePrivateDir } from "../store/paths";
import { fetchTextFromOrigins, type FetchOptions } from "./fetch-resource";
import { verifyMinisignPayload } from "./minisign";
import type { ParsedMinisignPublicKey, TrustedKeySet } from "./trusted-keys";

interface FeedPolicy {
  readonly policyRevision: number;
  readonly policyDigest: string;
}

export interface ReadSignedFeedOptions extends FetchOptions {
  readonly feed: ReleaseFeed;
  readonly trustedKeySet: TrustedKeySet;
  readonly validatePayload?: (
    payload: Record<string, unknown>,
    source: string,
  ) => void;
  readonly urls: readonly string[] | null;
  readonly fetchDocument:
    | ((url: string, opts: FetchOptions) => Promise<string>)
    | null;
}

export async function readSignedFeed(
  opts: ReadSignedFeedOptions,
): Promise<Record<string, unknown>> {
  const trusted = opts.trustedKeySet;
  const target = releaseFeedTarget();
  const floorText =
    opts.feed === "host" ? config.hostFeedFloor : config.cliFeedFloor;
  const floor = floorText === null ? 0 : Number(floorText);
  if (!Number.isSafeInteger(floor) || floor < 0)
    throw feedError("FEED_BUILD_FLOOR_INVALID");
  return fetchTextFromOrigins(
    opts.urls ?? signedFeedUrls(opts.feed),
    { ...opts, resource: "feed-envelope" },
    async (body, url, signal) => {
      const payload = verifyEnvelope(body, url, trusted.keys);
      if (payload.schemaVersion !== 2)
        throw feedError("FEED_UNSUPPORTED_SCHEMA");
      if (payload.feed !== opts.feed) throw feedError("FEED_WRONG_FEED");
      if (payload.target !== target) throw feedError("FEED_WRONG_TARGET");
      const generated =
        typeof payload.generatedAt === "string"
          ? Date.parse(payload.generatedAt)
          : NaN;
      const expires =
        typeof payload.expiresAt === "string"
          ? Date.parse(payload.expiresAt)
          : NaN;
      if (
        !Number.isFinite(generated) ||
        !Number.isFinite(expires) ||
        expires <= generated
      ) {
        throw feedError("FEED_INVALID_TIME");
      }
      if (generated > Date.now() + 24 * 60 * 60 * 1000)
        throw feedError("FEED_FUTURE_DATED");
      if (expires <= Date.now()) throw feedError("FEED_EXPIRED");
      const policy = parsePolicy(payload);
      if (policy.policyRevision < floor)
        throw feedError("FEED_BELOW_BUILD_FLOOR");
      opts.validatePayload?.(payload, url);
      await advanceWatermark(opts.feed, target, policy, signal);
      return payload;
    },
    opts.fetchDocument,
  );
}

function verifyEnvelope(
  body: string,
  url: string,
  keys: readonly ParsedMinisignPublicKey[],
): Record<string, unknown> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body);
  } catch {
    throw feedError("FEED_INVALID_ENVELOPE");
  }
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    !("payload" in envelope) ||
    !("signature" in envelope) ||
    !("keyId" in envelope) ||
    typeof envelope.payload !== "string" ||
    typeof envelope.signature !== "string" ||
    typeof envelope.keyId !== "string" ||
    !/^[a-f0-9]{16}$/i.test(envelope.keyId)
  ) {
    throw feedError("FEED_INVALID_ENVELOPE");
  }
  let keyId: string;
  try {
    keyId = verifyMinisignPayload(
      envelope.payload,
      envelope.signature,
      url,
      keys,
    ).keyId;
  } catch {
    throw feedError("FEED_SIGNATURE_INVALID");
  }
  if (keyId.toLowerCase() !== envelope.keyId.toLowerCase())
    throw feedError("FEED_KEY_ID_MISMATCH");
  let payload: unknown;
  try {
    payload = JSON.parse(envelope.payload);
  } catch {
    throw feedError("FEED_INVALID_PAYLOAD");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    throw feedError("FEED_INVALID_PAYLOAD");
  return payload as Record<string, unknown>;
}

function parsePolicy(value: Record<string, unknown>): FeedPolicy {
  if (
    typeof value.policyRevision !== "number" ||
    !Number.isSafeInteger(value.policyRevision) ||
    value.policyRevision < 1 ||
    typeof value.policyDigest !== "string" ||
    !/^[a-f0-9]{64}$/i.test(value.policyDigest)
  ) {
    throw feedError("FEED_INVALID_POLICY");
  }
  return {
    policyRevision: value.policyRevision,
    policyDigest: value.policyDigest.toLowerCase(),
  };
}

async function advanceWatermark(
  feed: ReleaseFeed,
  target: string,
  policy: FeedPolicy,
  signal: AbortSignal,
): Promise<void> {
  const dir = join(cliSharedHomeDir(), "feed-watermarks");
  await ensurePrivateDir(dir);
  const path = join(dir, `${target}-${feed}.json`);
  const outcome = await withCliScopedFileLock(
    {
      lockPath: `${path}.lock`,
      reason: "accept-release-feed",
      waitMs: 10_000,
      pollIntervalMs: 25,
    },
    async () => {
      signal.throwIfAborted();
      let current: FeedPolicy | null = null;
      try {
        const raw: unknown = JSON.parse(await readFile(path, "utf8"));
        if (raw === null || typeof raw !== "object" || Array.isArray(raw))
          throw feedError("FEED_WATERMARK_INVALID");
        current = parsePolicy(raw as Record<string, unknown>);
      } catch (cause) {
        if (
          !(
            cause instanceof Error &&
            "code" in cause &&
            cause.code === "ENOENT"
          )
        )
          throw cause;
      }
      if (current !== null) {
        if (policy.policyRevision < current.policyRevision)
          throw feedError("FEED_REPLAYED");
        if (policy.policyRevision === current.policyRevision) {
          if (policy.policyDigest !== current.policyDigest)
            throw feedError("FEED_POLICY_CONFLICT");
          return;
        }
      }
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temp, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(policy), "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        signal.throwIfAborted();
        await rename(temp, path);
        if (process.platform !== "win32") {
          const directory = await open(dir, "r");
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        }
      } finally {
        await rm(temp, { force: true });
      }
    },
  );
  if (outcome.kind === "busy") throw feedError("FEED_WATERMARK_BUSY");
}

function feedError(reason: string): Error {
  return cliError({
    code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
    message: `release feed: ${reason}`,
    details: { reason },
    exitCode: 1,
  });
}
