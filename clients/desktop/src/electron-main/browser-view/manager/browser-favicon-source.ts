import { describeLogError, log } from "../../app/logger";

/**
 * A favicon is a 16px glyph. This is generous for one and still small enough
 * that the base64 form can ride a status frame without the IPC boundary
 * becoming the reason a page feels slow.
 */
export const BROWSER_FAVICON_MAX_BYTES = 64 * 1024;

/**
 * The image types a favicon is served as in practice. An allowlist rather than
 * a check for `image/`, because `image/svg+xml` is a document format: it can
 * carry script, and while an `<img>` will not run it, there is no reason to
 * widen what the app's own document will decode.
 */
const BROWSER_FAVICON_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/bmp",
];

/** The subset of Electron's `Session` this reader needs, so a test can supply it. */
export interface BrowserFaviconFetcher {
  fetch(
    url: string,
    options: { readonly credentials: "omit"; readonly cache: "default" },
  ): Promise<{
    readonly ok: boolean;
    readonly status: number;
    readonly headers: { get(name: string): string | null };
    /**
     * The body as a stream, so the cap can be enforced DURING the transfer.
     *
     * Deliberately not `arrayBuffer()`: that resolves only once the whole body is
     * in memory, so a server that declares no length - or declares a false one -
     * gets main to allocate whatever it sends before any limit is consulted. The
     * limit has to be able to hang up mid-transfer, which needs the reader.
     */
    readonly body: {
      getReader(): {
        read(): Promise<{
          readonly done: boolean;
          readonly value?: Uint8Array;
        }>;
        cancel(): Promise<void>;
      };
    } | null;
  }>;
}

/**
 * Reads a page's declared icon and returns it as a `data:` URL, or `null` when
 * it cannot be had.
 *
 * The point of doing this in main at all is WHOSE request it is. Handing the
 * declared URL to the app renderer's `<img src>` made the privileged renderer
 * issue an HTTPS GET to an address a guest page chose - a page could name an
 * internal service it cannot reach itself and have the app reach it, and read
 * existence back out of whether the icon rendered.
 *
 * Fetching through the GUEST's own session removes that by construction rather
 * than by policy: the request now carries exactly the authority of the page that
 * declared it, and a page can already fetch what its own session can reach. No
 * address blocklist is needed, and there is none to get wrong or to be walked
 * around by a name that resolves differently the second time.
 *
 * ## Why there is deliberately no private-address block
 *
 * Two reasons, and the second is the decisive one.
 *
 * It would not close anything. With credentials omitted this request is what the
 * page itself could already issue as `fetch(url, { mode: "no-cors", credentials:
 * "omit" })`. The bytes go into a `data:` URL rendered in the app's TOOLBAR, not
 * back to the page, so the page cannot read a cross-origin response through it
 * either - it gains no reach and no read.
 *
 * And it would break the feature's main use. This tile exists largely to preview
 * local dev servers - the start page lists them and navigates to `localhost:PORT`
 * - so loopback and private addresses are the ORDINARY case here, not the
 * suspicious one. A block would leave exactly those pages without their icon
 * while protecting nothing.
 *
 * What remains are limits that hold whoever is asking: no credentials, an image
 * type, and a byte cap enforced against the body as it arrives.
 */
export async function readFaviconDataUrl(input: {
  readonly session: BrowserFaviconFetcher;
  readonly url: string;
}): Promise<string | null> {
  try {
    const response = await input.session.fetch(input.url, {
      // A favicon is public decoration. Sending the session's cookies would
      // make this a credentialed read whose result is then copied into the app's
      // own document.
      credentials: "omit",
      cache: "default",
    });
    if (!response.ok) return null;
    const mime = readImageMimeType(response.headers.get("content-type"));
    if (mime === null) return null;
    // Checked before reading so an honestly-declared oversized icon costs
    // nothing, and again after, because the header is the server's claim.
    if (exceedsCap(response.headers.get("content-length"))) return null;
    const body = await readCappedBody(response.body);
    if (body === null) return null;
    if (body.byteLength === 0) return null;
    return `data:${mime};base64,${body.toString("base64")}`;
  } catch (error: unknown) {
    // A favicon that will not load is not a failure worth surfacing: the tile
    // shows its fallback glyph, which is what the absence of an icon looks like
    // anyway.
    log.debug("[browser-view] favicon read failed", {
      ...describeLogError(error),
    });
    return null;
  }
}

/**
 * Reads a body, stopping the transfer as soon as it exceeds the cap.
 *
 * Returns `null` for an oversized body rather than a truncated one: half an icon
 * is not an icon, and decoding a partial image in the app's own document is not
 * something to invite.
 */
async function readCappedBody(
  body: {
    getReader(): {
      read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
      cancel(): Promise<void>;
    };
  } | null,
): Promise<Buffer | null> {
  if (body === null) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    const chunk = step.value;
    if (chunk === undefined) continue;
    total += chunk.byteLength;
    if (total > BROWSER_FAVICON_MAX_BYTES) {
      // Hangs up instead of draining: the point of the cap is not to read it.
      await reader.cancel();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function readImageMimeType(header: string | null): string | null {
  if (header === null) return null;
  const mime = header.split(";")[0]?.trim().toLowerCase();
  if (mime === undefined) return null;
  return BROWSER_FAVICON_MIME_TYPES.includes(mime) ? mime : null;
}

function exceedsCap(header: string | null): boolean {
  if (header === null) return false;
  const declared = Number.parseInt(header, 10);
  if (!Number.isFinite(declared)) return false;
  return declared > BROWSER_FAVICON_MAX_BYTES;
}
