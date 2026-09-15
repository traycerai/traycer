import { z } from "zod";
import { readCappedResponse } from "@/lib/themes/open-vsx";

/**
 * The curated wallpaper catalog we host. One production URL for every build,
 * schema-versioned in the path: a breaking change publishes `v2.json` and
 * leaves this one standing for clients already shipped.
 */
const MANIFEST_URL = "https://assets.traycer.ai/start-page/wallpapers/v1.json";
const MANIFEST_ORIGIN = new URL(MANIFEST_URL).origin;

const MANIFEST_MAX_BYTES = 256 * 1024;
const MANIFEST_TIMEOUT_MS = 15_000;
/** Hard ceiling on a download, regardless of what the manifest declares. */
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 60_000;

const pathSchema = z.string().min(1).max(512);

const manifestSchema = z.object({
  version: z.literal(1),
  wallpapers: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]{1,64}$/),
        title: z.string().min(1).max(80),
        full: z.object({
          path: pathSchema,
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          bytes: z.number().int().positive().max(IMAGE_MAX_BYTES),
        }),
        thumb: z.object({ path: pathSchema }),
      }),
    )
    .max(32),
});

export interface CuratedWallpaper {
  readonly id: string;
  readonly title: string;
  readonly fullUrl: string;
  readonly thumbUrl: string;
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * A manifest path is relative and stays on the manifest's own origin. A path
 * that escapes either rule rejects the WHOLE manifest rather than being
 * skipped: a catalog carrying an off-origin entry is one we did not publish,
 * and serving the rest of it as if nothing happened hides that.
 */
function resolveManifestPath(path: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) || path.startsWith("/"))
    throw new Error("A wallpaper path is not relative.");
  if (path.split("/").includes(".."))
    throw new Error("A wallpaper path escapes the catalog.");
  const url = new URL(path, MANIFEST_URL);
  if (url.origin !== MANIFEST_ORIGIN)
    throw new Error("A wallpaper path resolves off-origin.");
  return url.href;
}

function parseManifest(text: string): ReadonlyArray<CuratedWallpaper> {
  const manifest = manifestSchema.parse(JSON.parse(text));
  const wallpapers = manifest.wallpapers.map((entry) => ({
    id: entry.id,
    title: entry.title,
    fullUrl: resolveManifestPath(entry.full.path),
    thumbUrl: resolveManifestPath(entry.thumb.path),
    sha256: entry.full.sha256,
    bytes: entry.full.bytes,
  }));
  if (new Set(wallpapers.map((entry) => entry.id)).size !== wallpapers.length)
    throw new Error("The catalog repeats a wallpaper id.");
  return wallpapers;
}

function requestInit(
  signal: AbortSignal,
  timeoutMs: number,
): RequestInit & { readonly signal: AbortSignal } {
  return {
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    credentials: "omit",
    referrerPolicy: "no-referrer",
  };
}

export async function fetchCuratedWallpaperManifest(
  signal: AbortSignal,
): Promise<ReadonlyArray<CuratedWallpaper>> {
  const response = await fetch(
    MANIFEST_URL,
    requestInit(signal, MANIFEST_TIMEOUT_MS),
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `The wallpaper catalog could not be loaded (${response.status}).`,
    );
  }
  const bytes = await readCappedResponse(
    response,
    MANIFEST_MAX_BYTES,
    "The wallpaper catalog is larger than this build accepts.",
  );
  try {
    return parseManifest(new TextDecoder().decode(bytes));
  } catch {
    // Every shape failure reads the same to a user: the catalog we served is
    // not one this build can trust. The detail is ours to fix, not theirs.
    throw new Error("The wallpaper catalog could not be read.");
  }
}

function hex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function downloadCuratedWallpaper(
  entry: CuratedWallpaper,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await fetch(
    entry.fullUrl,
    requestInit(signal, IMAGE_TIMEOUT_MS),
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `The wallpaper could not be downloaded (${response.status}).`,
    );
  }
  const bytes = await readCappedResponse(
    response,
    Math.min(IMAGE_MAX_BYTES, entry.bytes),
    "The wallpaper download is larger than the catalog declared.",
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  if (hex(digest) !== entry.sha256)
    throw new Error(
      "The downloaded wallpaper failed its integrity check. Try again.",
    );
  // `validateAppearanceImage` requires the blob's declared type to match the
  // sniffed bytes, so the response's own type is what has to travel with them.
  const declared = response.headers.get("content-type")?.split(";")[0]?.trim();
  return new Blob([bytes.slice().buffer], {
    type:
      declared !== undefined && declared.startsWith("image/")
        ? declared
        : "image/webp",
  });
}
