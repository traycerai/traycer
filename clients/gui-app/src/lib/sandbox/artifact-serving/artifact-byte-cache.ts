import type {
  ArtifactReadSpan,
  ArtifactReadSpanResult,
} from "./artifact-server";

type Bytes = Extract<ArtifactReadSpanResult, { bytes: Uint8Array }>;
interface PendingRead {
  readonly controller: AbortController;
  readonly result: Promise<ArtifactReadSpanResult>;
  readers: number;
}

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
// Tiny files must not turn a byte budget into an unbounded map.
const MAX_ENTRIES = 1024;

/** Raw content only: composed documents contain a mount's nonce and theme. */
export function createArtifactByteCache(read: ArtifactReadSpan): {
  readonly readSpan: ArtifactReadSpan;
  readonly clear: () => void;
} {
  const cached = new Map<string, Bytes>();
  const pending = new Map<string, PendingRead>();
  let bytes = 0;

  const readSpan: ArtifactReadSpan = async (hash, offset, length, signal) => {
    signal.throwIfAborted();
    const key = `${hash}:${offset}:${length}`;
    const hit = cached.get(key);
    if (hit !== undefined) {
      cached.delete(key);
      cached.set(key, hit);
      return hit;
    }
    let request = pending.get(key);
    if (request === undefined) {
      const controller = new AbortController();
      const result = read(hash, offset, length, controller.signal).then(
        (value) => {
          if (
            !controller.signal.aborted &&
            "bytes" in value &&
            value.totalBytes <= MAX_FILE_BYTES &&
            value.bytes.byteLength <= MAX_BYTES
          ) {
            cached.set(key, value);
            bytes += value.bytes.byteLength;
            while (bytes > MAX_BYTES || cached.size > MAX_ENTRIES) {
              const oldest = cached.entries().next().value;
              if (oldest === undefined) break;
              cached.delete(oldest[0]);
              bytes -= oldest[1].bytes.byteLength;
            }
          }
          return value;
        },
      );
      request = { controller, result, readers: 0 };
      pending.set(key, request);
    }
    const shared = request;
    shared.readers++;
    let onAbort = (): void => {};
    try {
      // One evicted board must not cancel another board's shared stylesheet.
      return await Promise.race([
        shared.result,
        new Promise<never>((_resolve, reject) => {
          onAbort = () => {
            const reason: unknown = signal.reason;
            reject(
              reason instanceof Error
                ? reason
                : new DOMException("Artifact read aborted", "AbortError"),
            );
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (--shared.readers === 0) {
        if (pending.get(key) === shared) pending.delete(key);
        shared.controller.abort();
      }
    }
  };
  return {
    readSpan,
    clear() {
      cached.clear();
      bytes = 0;
      for (const request of pending.values()) request.controller.abort();
      pending.clear();
    },
  };
}
