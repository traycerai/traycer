import { describe, expect, it } from "vitest";
import {
  BROWSER_FAVICON_MAX_BYTES,
  readFaviconDataUrl,
  type BrowserFaviconFetcher,
} from "../browser-favicon-source";

interface FetchLog {
  readonly urls: string[];
  readonly credentials: string[];
  /** Set when the reader was hung up on, which is how the cap must behave. */
  cancelled: boolean;
}

function fetcher(
  response: {
    readonly ok?: boolean;
    readonly status?: number;
    readonly contentType?: string | null;
    readonly contentLength?: string | null;
    readonly bytes?: number;
  },
  log: FetchLog,
): BrowserFaviconFetcher {
  return {
    fetch: (url, options) => {
      log.urls.push(url);
      log.credentials.push(options.credentials);
      return Promise.resolve({
        ok: response.ok ?? true,
        status: response.status ?? 200,
        headers: {
          get: (name: string) => {
            const key = name.toLowerCase();
            if (key === "content-type") return response.contentType ?? "image/png";
            if (key === "content-length") return response.contentLength ?? null;
            return null;
          },
        },
        // Delivered in chunks, as a socket would, so the cap is exercised
        // mid-transfer rather than against one finished buffer.
        body: streamOf(response.bytes ?? 4, log),
      });
    },
  };
}

/**
 * A body of `total` bytes delivered 8 KiB at a time.
 *
 * Chunked on purpose: a single-chunk fake would let a reader that only checks
 * the total AFTER reading everything still pass.
 */
function streamOf(total: number, log: FetchLog) {
  const chunk = 8 * 1024;
  let sent = 0;
  return {
    getReader: () => ({
      read: () => {
        if (sent >= total) return Promise.resolve({ done: true });
        const size = Math.min(chunk, total - sent);
        sent += size;
        return Promise.resolve({ done: false, value: new Uint8Array(size) });
      },
      cancel: () => {
        log.cancelled = true;
        return Promise.resolve();
      },
    }),
  };
}

function emptyLog(): FetchLog {
  return { urls: [], credentials: [], cancelled: false };
}

describe("readFaviconDataUrl", () => {
  it("returns the icon as a data URL so no remote address reaches a renderer", async () => {
    const log = emptyLog();
    const result = await readFaviconDataUrl({
      session: fetcher({}, log),
      url: "https://example.test/favicon.png",
    });

    expect(result).toBe("data:image/png;base64,AAAAAA==");
    expect(result?.startsWith("data:")).toBe(true);
  });

  it("reads through the session it was given, never a shared one", async () => {
    const log = emptyLog();
    await readFaviconDataUrl({
      session: fetcher({}, log),
      url: "https://internal.test/icon.png",
    });

    // The whole point of the main-side read: the request carries the guest's
    // authority, so the URL must have gone to the session passed in.
    expect(log.urls).toEqual(["https://internal.test/icon.png"]);
  });

  it("omits credentials so a public glyph is not an authenticated read", async () => {
    const log = emptyLog();
    await readFaviconDataUrl({
      session: fetcher({}, log),
      url: "https://example.test/favicon.png",
    });

    expect(log.credentials).toEqual(["omit"]);
  });

  it("refuses a non-image response", async () => {
    const log = emptyLog();
    const result = await readFaviconDataUrl({
      session: fetcher({ contentType: "text/html" }, log),
      url: "https://example.test/login",
    });

    expect(result).toBeNull();
  });

  it("refuses SVG, which is a document format rather than a glyph", async () => {
    const log = emptyLog();
    const result = await readFaviconDataUrl({
      session: fetcher({ contentType: "image/svg+xml" }, log),
      url: "https://example.test/icon.svg",
    });

    expect(result).toBeNull();
  });

  it("refuses a failed response", async () => {
    const log = emptyLog();
    const result = await readFaviconDataUrl({
      session: fetcher({ ok: false, status: 404 }, log),
      url: "https://example.test/missing.png",
    });

    expect(result).toBeNull();
  });

  it("refuses an oversized icon on its declared length", async () => {
    const log = emptyLog();
    const result = await readFaviconDataUrl({
      session: fetcher(
        { contentLength: String(BROWSER_FAVICON_MAX_BYTES + 1) },
        log,
      ),
      url: "https://example.test/huge.png",
    });

    expect(result).toBeNull();
  });

  it("refuses an oversized body that declared nothing", async () => {
    const log = emptyLog();
    const result = await readFaviconDataUrl({
      session: fetcher(
        { contentLength: null, bytes: BROWSER_FAVICON_MAX_BYTES + 1 },
        log,
      ),
      url: "https://example.test/lying.png",
    });

    // The cap has to hold against the body delivered, not the header claimed.
    expect(result).toBeNull();
  });

  it("refuses an empty body rather than emitting an empty data URL", async () => {
    const log = emptyLog();
    const result = await readFaviconDataUrl({
      session: fetcher({ bytes: 0 }, log),
      url: "https://example.test/blank.png",
    });

    expect(result).toBeNull();
  });

  it("returns null when the fetch itself throws", async () => {
    const result = await readFaviconDataUrl({
      session: {
        fetch: () => Promise.reject(new Error("offline")),
      },
      url: "https://example.test/favicon.png",
    });

    expect(result).toBeNull();
  });

  it("hangs up mid-transfer on a body that exceeds the cap", async () => {
    const log = emptyLog();
    const result = await readFaviconDataUrl({
      // Declares nothing and then sends far too much - the case `arrayBuffer()`
      // would have fully buffered before any limit was consulted.
      session: fetcher(
        { contentLength: null, bytes: BROWSER_FAVICON_MAX_BYTES * 4 },
        log,
      ),
      url: "https://example.test/flood.png",
    });

    expect(result).toBeNull();
    expect(log.cancelled).toBe(true);
  });

  it("does not read the whole body before refusing it", async () => {
    const log = emptyLog();
    await readFaviconDataUrl({
      session: fetcher(
        { contentLength: null, bytes: BROWSER_FAVICON_MAX_BYTES * 100 },
        log,
      ),
      url: "https://example.test/huge.png",
    });

    // Cancelling is the observable proof that it stopped early; a reader that
    // drained first would finish without ever calling cancel.
    expect(log.cancelled).toBe(true);
  });

  it("refuses a response with no body at all", async () => {
    const result = await readFaviconDataUrl({
      session: {
        fetch: () =>
          Promise.resolve({
            ok: true,
            status: 200,
            headers: {
              get: (name: string) =>
                name.toLowerCase() === "content-type" ? "image/png" : null,
            },
            body: null,
          }),
      },
      url: "https://example.test/headers-only.png",
    });

    expect(result).toBeNull();
  });
});
