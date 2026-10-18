import {
  EPIC_READ_ARTIFACT_OBJECT_RANGE_MAX_BYTES,
  EPIC_READ_ARTIFACT_OBJECT_TEXT_MAX_BYTES,
} from "@traycer/protocol/host/epic/artifact-objects";
import { isArtifactPath } from "./artifact-address";
import {
  buildArtifactDocument,
  type ArtifactDocumentOptions,
} from "./artifact-document";
import {
  resolveManifestPath,
  type ArtifactManifest,
  type ArtifactManifestEntry,
} from "./artifact-manifest";

export type ArtifactReadSpanResult =
  | {
      readonly bytes: Uint8Array;
      readonly totalBytes: number;
      readonly mediaType: string;
    }
  | { readonly unavailable: string };

export type ArtifactReadSpan = (
  sha256: string,
  offset: number,
  length: number,
  signal: AbortSignal,
) => Promise<ArtifactReadSpanResult>;

export type ArtifactOutsideReferenceResolver = (
  path: string,
) => ArtifactManifestEntry | null;

export interface ArtifactServerOptions {
  /** Folder relative to the artifacts tree root; empty for its root artifact. */
  readonly treePath: string;
  readonly manifest: ArtifactManifest;
  readonly readSpan: ArtifactReadSpan;
  readonly document: ArtifactDocumentOptions;
  readonly resolveOutsideReference?: ArtifactOutsideReferenceResolver;
}

export interface ArtifactServeRequest {
  /** Full decoded request path relative to the artifacts tree root. */
  readonly path: string;
  readonly offset: number;
  readonly length: number;
  readonly signal: AbortSignal;
}

export type ArtifactServeResult =
  | {
      readonly kind: "bytes";
      readonly bytes: Uint8Array;
      readonly offset: number;
      readonly totalBytes: number;
      readonly mediaType: string;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
      readonly status: 404 | 503;
    };

type Unavailable = Extract<ArtifactServeResult, { kind: "unavailable" }>;

interface ResolvedFile {
  readonly entry: ArtifactManifestEntry;
  readonly compose: boolean;
}

interface CachedBytes {
  readonly kind: "block" | "document";
  readonly sha256: string;
  readonly sourceSize: number;
  readonly bytes: Uint8Array;
}

type ReadResult = CachedBytes | Unavailable;

const CACHE_MAX_BYTES = 64 * 1024 * 1024;
// Empty and tiny objects still retain map entries, keys and byte-array objects.
const CACHE_MAX_ENTRIES = 1024;
const BLOCK_BYTES = EPIC_READ_ARTIFACT_OBJECT_RANGE_MAX_BYTES;
const NO_OUTSIDE_REFERENCE: ArtifactOutsideReferenceResolver = () => null;

function unavailable(reason: string, status: 404 | 503): Unavailable {
  return { kind: "unavailable", reason, status };
}

function isDocument(path: string, entry: ArtifactManifestEntry): boolean {
  return (
    entry.mediaType.split(";", 1)[0].trim().toLowerCase() === "text/html" ||
    /\.html?$/i.test(path)
  );
}

function isValidRange(offset: number, length: number): boolean {
  return (
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    Number.isSafeInteger(length) &&
    length > 0
  );
}

/** An individual cancellation must not cancel a load another request shares. */
function waitForRead(
  pending: Promise<ReadResult>,
  signal: AbortSignal,
): Promise<ReadResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener("abort", abort);
      const reason: unknown = signal.reason;
      reject(
        reason instanceof Error
          ? reason
          : new DOMException("The artifact request was aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(
          error instanceof Error
            ? error
            : new Error("The artifact read failed", { cause: error }),
        );
      },
    );
  });
}

/** One immutable manifest and document context per mounted artifact. */
export class ArtifactServer {
  private readonly cache = new Map<string, CachedBytes>();
  private readonly pending = new Map<string, Promise<ReadResult>>();
  private cacheBytes = 0;
  private readonly outside: ArtifactOutsideReferenceResolver;
  private readonly treePrefix: string;
  private readonly readSignal = new AbortController().signal;

  constructor(private readonly options: ArtifactServerOptions) {
    if (options.treePath !== "" && !isArtifactPath(options.treePath)) {
      throw new Error("Invalid artifact tree path");
    }
    this.treePrefix = options.treePath === "" ? "" : `${options.treePath}/`;
    this.outside = options.resolveOutsideReference ?? NO_OUTSIDE_REFERENCE;
  }

  async serve(request: ArtifactServeRequest): Promise<ArtifactServeResult> {
    const { path, offset, signal } = request;
    signal.throwIfAborted();
    if (!isArtifactPath(path)) return unavailable("missing", 404);
    if (!isValidRange(offset, request.length)) {
      return unavailable("invalid-range", 404);
    }
    const resolved = this.resolve(path);
    if (resolved === null) return unavailable("missing", 404);
    const { entry } = resolved;
    if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) {
      return unavailable("invalid-size", 503);
    }
    const length = Math.min(request.length, BLOCK_BYTES);
    if (resolved.compose) {
      const document = await waitForRead(
        this.documentBytes(path, entry),
        signal,
      );
      if (document.kind === "unavailable") return document;
      if (document.sourceSize !== entry.byteLength) {
        return unavailable("invalid-span", 503);
      }
      signal.throwIfAborted();
      // The native v1 response has no 416 variant; a range past EOF maps to 404.
      if (offset > document.bytes.length) {
        return unavailable("invalid-range", 404);
      }
      return {
        kind: "bytes",
        bytes: document.bytes.slice(offset, offset + length),
        offset,
        totalBytes: document.bytes.length,
        mediaType: "text/html; charset=utf-8",
      };
    }
    // The native v1 response has no 416 variant; a range past EOF maps to 404.
    if (offset > entry.byteLength) return unavailable("invalid-range", 404);
    const bytes = await this.rangeBytes(entry, offset, length, signal);
    signal.throwIfAborted();
    if (!(bytes instanceof Uint8Array)) return bytes;
    return {
      kind: "bytes",
      bytes,
      offset,
      totalBytes: entry.byteLength,
      mediaType: entry.mediaType,
    };
  }

  private resolve(path: string): ResolvedFile | null {
    const own = path.startsWith(this.treePrefix)
      ? resolveManifestPath(
          this.options.manifest,
          path.slice(this.treePrefix.length),
        )
      : null;
    if (own !== null) return { entry: own, compose: isDocument(path, own) };
    // A miss inside our prefix may name a child artifact. The resolver needs
    // the full tree path in both cases, and referenced files stay unmodified.
    const outside = this.outside(path);
    return outside === null ? null : { entry: outside, compose: false };
  }

  private async rangeBytes(
    entry: ArtifactManifestEntry,
    offset: number,
    length: number,
    signal: AbortSignal,
  ): Promise<Uint8Array | Unavailable> {
    const end = offset + Math.min(length, entry.byteLength - offset);
    const bytes = new Uint8Array(end - offset);
    // Even an empty object must be checked for availability at least once.
    if (entry.byteLength === 0) {
      const block = await waitForRead(this.block(entry, 0), signal);
      return block.kind === "unavailable" ? block : bytes;
    }
    let cursor = offset;
    while (cursor < end) {
      const index = Math.floor(cursor / BLOCK_BYTES);
      const block = await waitForRead(this.block(entry, index), signal);
      if (block.kind === "unavailable") return block;
      if (block.sourceSize !== entry.byteLength) {
        return unavailable("invalid-span", 503);
      }
      signal.throwIfAborted();
      const start = cursor - index * BLOCK_BYTES;
      const count = Math.min(block.bytes.length - start, end - cursor);
      bytes.set(block.bytes.subarray(start, start + count), cursor - offset);
      cursor += count;
    }
    return bytes;
  }

  private documentBytes(
    path: string,
    entry: ArtifactManifestEntry,
  ): Promise<ReadResult> {
    if (entry.byteLength > EPIC_READ_ARTIFACT_OBJECT_TEXT_MAX_BYTES) {
      return Promise.resolve(unavailable("document-too-large", 503));
    }
    const key = `document:${path}`;
    const cached = this.cached(key, entry);
    if (cached !== null) return Promise.resolve(cached);
    // Reuse the existing path's entry for aliases instead of retaining a
    // second byte buffer or an unbounded alias-to-document index.
    for (const [otherKey, candidate] of this.cache) {
      if (
        candidate.kind === "document" &&
        candidate.sha256 === entry.sha256 &&
        candidate.sourceSize === entry.byteLength
      ) {
        this.touch(otherKey, candidate);
        return Promise.resolve(candidate);
      }
    }
    return this.coalesce(`compose:${entry.sha256}`, async () => {
      const bytes = await this.rangeBytes(
        entry,
        0,
        entry.byteLength,
        this.readSignal,
      );
      if (!(bytes instanceof Uint8Array)) return bytes;
      const document: CachedBytes = {
        kind: "document",
        sha256: entry.sha256,
        sourceSize: entry.byteLength,
        bytes: new TextEncoder().encode(
          buildArtifactDocument(
            new TextDecoder().decode(bytes),
            this.options.document,
          ),
        ),
      };
      this.insert(key, document);
      return document;
    });
  }

  private block(
    entry: ArtifactManifestEntry,
    index: number,
  ): Promise<ReadResult> {
    const key = `block:${entry.sha256}:${index}`;
    const cached = this.cached(key, entry);
    if (cached !== null) return Promise.resolve(cached);
    return this.coalesce(key, async () => {
      const result = await this.loadBlock(entry, index);
      if (result.kind !== "unavailable") this.insert(key, result);
      return result;
    });
  }

  private async loadBlock(
    entry: ArtifactManifestEntry,
    index: number,
  ): Promise<ReadResult> {
    const offset = index * BLOCK_BYTES;
    const bytes = new Uint8Array(
      Math.min(BLOCK_BYTES, entry.byteLength - offset),
    );
    let received = 0;
    do {
      const length = Math.max(1, bytes.length - received);
      const response = await this.options.readSpan(
        entry.sha256,
        offset + received,
        length,
        this.readSignal,
      );
      if ("unavailable" in response) {
        return unavailable(
          response.unavailable,
          response.unavailable === "missing" ? 404 : 503,
        );
      }
      if (
        response.totalBytes !== entry.byteLength ||
        response.bytes.length > bytes.length - received ||
        (response.bytes.length === 0 && bytes.length > 0)
      ) {
        return unavailable("invalid-span", 503);
      }
      // The port may reuse its buffer after a read completes.
      bytes.set(response.bytes, received);
      received += response.bytes.length;
    } while (received < bytes.length);
    return {
      kind: "block",
      sha256: entry.sha256,
      sourceSize: entry.byteLength,
      bytes,
    };
  }

  private coalesce(
    key: string,
    start: () => Promise<ReadResult>,
  ): Promise<ReadResult> {
    const existing = this.pending.get(key);
    if (existing !== undefined) return existing;
    const pending = start();
    this.pending.set(key, pending);
    const release = (): void => {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    };
    // Both settlement paths consume the cleanup promise, including port errors.
    void pending.then(release, release);
    return pending;
  }

  private cached(
    key: string,
    entry: ArtifactManifestEntry,
  ): CachedBytes | null {
    const value = this.cache.get(key);
    if (
      value === undefined ||
      value.sha256 !== entry.sha256 ||
      value.sourceSize !== entry.byteLength
    ) {
      return null;
    }
    this.touch(key, value);
    return value;
  }

  private touch(key: string, value: CachedBytes): void {
    this.cache.delete(key);
    this.cache.set(key, value);
  }

  private remove(key: string): void {
    const current = this.cache.get(key);
    if (current === undefined) return;
    this.cache.delete(key);
    this.cacheBytes -= current.bytes.length;
  }

  private insert(key: string, value: CachedBytes): void {
    // A read may have awaited through replacement or eviction of this key.
    // Charge only what is present now, and publish once per shared producer.
    this.remove(key);
    if (value.bytes.length > CACHE_MAX_BYTES) return;
    while (
      this.cacheBytes + value.bytes.length > CACHE_MAX_BYTES ||
      this.cache.size >= CACHE_MAX_ENTRIES
    ) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.remove(oldest.value);
    }
    this.cache.set(key, value);
    this.cacheBytes += value.bytes.length;
  }
}
