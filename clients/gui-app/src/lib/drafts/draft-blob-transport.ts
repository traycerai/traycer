import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { DraftWrite } from "@traycer/protocol/host";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import {
  getImageBytes,
  putImageBytesAtHash,
} from "@/lib/composer/landing-image-store";
import { bytesToBase64, base64ToBytes } from "@/lib/composer/image-base64";
import { sniffImageMimeType } from "@/lib/composer/prompt-stash-image-signature";
import { readPromptStashRestoreBlobs } from "@/lib/composer/prompt-stash-repository";
import type { PromptStashImageBlob } from "@/lib/composer/prompt-stash-codec";
import { appLogger, describeLogError } from "@/lib/logger";
import { blobHashesOfWrite } from "./draft-write-codec";
import { isDraftsCapabilityMissing } from "./draft-capability";

const blobUnsupportedHosts = new Set<string>();

export function resetDraftBlobTransportForTests(): void {
  blobUnsupportedHosts.clear();
}

/**
 * Drop the "this host withholds blob methods" cache so the next put/read
 * re-probes. Same shape as T6's scope-cache invalidate: a reconnecting
 * session (host upgraded mid-lifetime) is the signal, not a timer.
 */
export function forgetBlobUnsupportedHost(hostId: string): void {
  blobUnsupportedHosts.delete(hostId);
}

export function hostWithholdsDraftBlobs(hostId: string): boolean {
  return blobUnsupportedHosts.has(hostId);
}

function markBlobUnsupported(hostId: string): void {
  blobUnsupportedHosts.add(hostId);
}

function isBlobUnsupported(error: unknown): boolean {
  return (
    isDraftsCapabilityMissing(error) ||
    (error instanceof HostRpcError && error.code === "E_HOST_UNSUPPORTED")
  );
}

async function localBytesForHash(
  hash: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const fromLanding = await getImageBytes(hash);
  if (fromLanding !== undefined) return fromLanding;
  const stash = await readPromptStashRestoreBlobs([hash]);
  if (stash.status !== "ok") return null;
  return stash.blobs.get(hash)?.bytes ?? null;
}

/**
 * Upload every `blobHashes` entry the local partition (or stash repo)
 * still holds. Missing local bytes and digest-mismatch skip that hash
 * (fail closed per-image). A host that withholds the methods is treated
 * as an old host: hash-only content, never an error surface.
 */
export type DraftBlobClient = {
  readonly request: HostRequester<HostRpcRegistry>["request"];
};

export async function putDraftBlobsForWrite(
  hostId: string,
  client: DraftBlobClient,
  write: DraftWrite,
): Promise<ReadonlyArray<string>> {
  return putDraftBlobs(hostId, client, blobHashesOfWrite(write));
}

export async function putDraftBlobs(
  hostId: string,
  client: DraftBlobClient,
  hashes: readonly string[],
): Promise<ReadonlyArray<string>> {
  if (hashes.length === 0) return [];
  if (blobUnsupportedHosts.has(hostId)) return [];
  const confirmed: string[] = [];
  for (const sha256 of hashes) {
    const bytes = await localBytesForHash(sha256);
    if (bytes === null) continue;
    try {
      const response = await client.request("drafts.putBlob", {
        sha256,
        bytesBase64: bytesToBase64(bytes),
      });
      if (response.ok) {
        confirmed.push(sha256);
        continue;
      }
      appLogger.warn("[draft-blobs] putBlob digest-mismatch", { sha256 });
    } catch (error: unknown) {
      if (isBlobUnsupported(error)) {
        markBlobUnsupported(hostId);
        return confirmed;
      }
      appLogger.warn("[draft-blobs] putBlob failed", {
        sha256,
        error: describeLogError(error),
      });
    }
  }
  return confirmed;
}

/**
 * Fetch missing hashes into the window-partitioned landing-image-store.
 * Already-local hashes are left alone. `missing` / corrupt collapse to
 * skip (images render unavailable).
 */
export async function readDraftBlobsIntoLocalStore(
  hostId: string,
  client: DraftBlobClient,
  hashes: readonly string[],
): Promise<ReadonlyMap<string, PromptStashImageBlob>> {
  const images = new Map<string, PromptStashImageBlob>();
  if (hashes.length === 0) return images;
  if (blobUnsupportedHosts.has(hostId)) return images;
  for (const sha256 of hashes) {
    const existing = await getImageBytes(sha256);
    if (existing !== undefined) {
      const mimeType = sniffImageMimeType(existing) ?? "image/png";
      images.set(sha256, { bytes: existing, mimeType });
      continue;
    }
    try {
      const response = await client.request("drafts.readBlob", { sha256 });
      if (!response.ok) continue;
      const bytes = base64ToBytes(response.bytesBase64);
      if (bytes === null) continue;
      const stored = await putImageBytesAtHash(sha256, bytes);
      if (!stored) continue;
      const mimeType = sniffImageMimeType(bytes) ?? "image/png";
      images.set(sha256, { bytes, mimeType });
    } catch (error: unknown) {
      if (isBlobUnsupported(error)) {
        markBlobUnsupported(hostId);
        return images;
      }
      appLogger.warn("[draft-blobs] readBlob failed", {
        sha256,
        error: describeLogError(error),
      });
    }
  }
  return images;
}
