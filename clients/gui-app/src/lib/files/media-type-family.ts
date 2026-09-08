/**
 * The six viewer families the file-rendering core is keyed by (D27), and the
 * sniffed-media-type -> family function both halves of the core share.
 *
 * Its own module rather than a member of `viewer-registry.ts` because
 * `byte-source.ts` needs the family to decide URL-vs-blob delivery (D10) and
 * must not pull the registry's component graph - pdf.js's lazy loader, the
 * Diffs renderer - into every surface (and every test) that only wants bytes.
 *
 * The input is always a SNIFFED type: the host's `epic.readFile` answers with
 * the value the server will send as `Content-Type`, and the asset stream's
 * header carries its own magic-byte verdict. A file EXTENSION never reaches
 * here - that is the whole point of the media type travelling on the wire.
 */

/**
 * Resolution order is the fallback chain of D27 - image, video, pdf, text/code,
 * html, binary - and `binary` is the terminal arm, never a failure: an
 * unrecognized type renders as a file with a download affordance.
 */
export type ViewerFamily =
  | "image"
  | "video"
  | "pdf"
  | "text"
  | "html"
  | "binary";

/**
 * Parameters and case are stripped before matching: a sniffed type legitimately
 * arrives as `text/html; charset=utf-8` or `IMAGE/PNG`, and a chain that
 * compared the raw string would route both to `binary`.
 */
function essenceOf(mediaType: string): string {
  const semicolon = mediaType.indexOf(";");
  const essence = semicolon === -1 ? mediaType : mediaType.slice(0, semicolon);
  return essence.trim().toLowerCase();
}

/**
 * Text-shaped types that are not under `text/*`. Kept small and explicit: the
 * `+json` / `+xml` structured-suffix convention would sweep in
 * `application/vnd.<anything>+xml`, and a viewer that decodes arbitrary vendor
 * payloads as source is a worse answer than the binary placeholder.
 */
const TEXTUAL_APPLICATION_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
]);

/**
 * `text/html` resolves to `html` and NOT to `text` even though it is text: D32
 * gives HTML its own viewer entry (code view plus an "Open in browser" action
 * on the epic's loopback static server), and the two are different capability
 * sets, not different copy.
 *
 * `image/svg+xml` resolves to `image`, matching what the app already does - it
 * is text to git and to `readFile`, and the image surfaces own the
 * sanitization gate that makes rendering it safe.
 */
export function mediaTypeFamily(mediaType: string): ViewerFamily {
  const essence = essenceOf(mediaType);
  if (essence === "text/html" || essence === "application/xhtml+xml") {
    return "html";
  }
  if (essence.startsWith("image/")) return "image";
  if (essence.startsWith("video/")) return "video";
  if (essence === "application/pdf") return "pdf";
  if (essence.startsWith("text/")) return "text";
  if (TEXTUAL_APPLICATION_TYPES.has(essence)) return "text";
  return "binary";
}

/**
 * Whether the browser element for this family fetches its own bytes, so a
 * short-lived signed URL may be handed to it directly (D10): `<img>` and
 * `<video>` own their range requests, seeking and their own cache, and running
 * a 500 MB clip through `fetch()` into a Blob to hand back a `blob:` URL would
 * defeat every one of those. Everything else is fetched into a blob, which is
 * also what keeps a signed cloud URL out of an `<iframe>`/`<a href>`.
 */
export function familyAcceptsDirectUrl(family: ViewerFamily): boolean {
  return family === "image" || family === "video";
}
