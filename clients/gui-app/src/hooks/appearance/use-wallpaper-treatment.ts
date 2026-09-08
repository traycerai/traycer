import { useEffect, useState } from "react";
import {
  appearanceAssetKey,
  captureAppearanceSession,
  isAppearanceSessionCurrent,
  readAppearanceBlob,
  writeAppearanceBlob,
  type AppearanceScope,
} from "@/lib/appearance/appearance-cache";
import {
  imageBlobCache,
  type ImageBlobLease,
  type ImageBytesResult,
} from "@/lib/attachments/image-blob-cache";

export interface WallpaperTreatmentInput {
  readonly scope: AppearanceScope | null;
  readonly originalUrl: string | null;
  readonly treatment: "original" | "texture" | "dither";
  readonly strength: number;
  readonly persist: boolean;
}

function assertCurrent(
  scope: AppearanceScope | null,
  session: number,
  signal: AbortSignal,
): void {
  signal.throwIfAborted();
  if (!isAppearanceSessionCurrent(scope?.accountId ?? null, session)) {
    throw new Error("Appearance session changed.");
  }
}

function loadAppearanceImagePreparation() {
  return import("@/lib/appearance/appearance-image-preparation");
}

async function deriveWallpaper(
  args: {
    readonly scope: AppearanceScope | null;
    readonly identity: string;
    readonly original: Blob;
    readonly strength: number;
    readonly persist: boolean;
    readonly session: number;
  },
  signal: AbortSignal,
): Promise<ImageBytesResult> {
  assertCurrent(args.scope, args.session, signal);
  let blob = args.persist
    ? await readAppearanceBlob(args.scope, args.identity)
    : null;
  assertCurrent(args.scope, args.session, signal);
  if (blob === null) {
    const { runAppearanceImageProcessing } =
      await loadAppearanceImagePreparation();
    assertCurrent(args.scope, args.session, signal);
    const result = await runAppearanceImageProcessing(
      { kind: "dither", blob: args.original, strength: args.strength },
      signal,
    );
    assertCurrent(args.scope, args.session, signal);
    blob = result.blob;
    // Quota/private-mode failures must not hide otherwise usable artwork.
    if (args.persist)
      await writeAppearanceBlob(args.scope, args.identity, blob).catch(
        () => {},
      );
  }
  assertCurrent(args.scope, args.session, signal);
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mediaType: blob.type,
  };
}

/** Original/texture need no pixel work. Shared leases cancel obsolete dithering. */
export function useWallpaperTreatment(
  input: WallpaperTreatmentInput,
): string | null {
  const { originalUrl, treatment, strength, persist } = input;
  const accountId = input.scope?.accountId ?? null;
  const hostId = input.scope?.hostId ?? null;
  const canonicalSourceRoot = input.scope?.canonicalSourceRoot ?? null;
  const identity = JSON.stringify([
    accountId,
    hostId,
    canonicalSourceRoot,
    originalUrl,
    treatment,
    strength,
    persist,
  ]);
  const [derived, setDerived] = useState<{
    identity: string;
    url: string;
  } | null>(null);

  useEffect(() => {
    if (originalUrl === null || treatment !== "dither" || strength === 0)
      return;
    const scope =
      accountId === null || hostId === null || canonicalSourceRoot === null
        ? null
        : { accountId, hostId, canonicalSourceRoot };
    const session = captureAppearanceSession();
    const controller = new AbortController();
    let lease: ImageBlobLease | null = null;
    // Coalesce slider changes before any fetch/decode/worker allocation.
    const timer = setTimeout(() => {
      const load = async () => {
        const response = await fetch(originalUrl, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Wallpaper image is unavailable.");
        const original = await response.blob();
        const { appearanceContentHash } =
          await loadAppearanceImagePreparation();
        const hash = await appearanceContentHash(original);
        assertCurrent(scope, session, controller.signal);
        const cacheIdentity = `derived:v1:${hash}:dither:${strength}`;
        lease = imageBlobCache.acquire(
          cacheIdentity,
          "image/webp",
          {
            scopeKey: appearanceAssetKey(
              scope,
              `wallpaper-treatment:${session}:${persist ? "saved" : "preview"}`,
            ),
            fetch: (_key, signal) =>
              deriveWallpaper(
                {
                  scope,
                  identity: cacheIdentity,
                  original,
                  strength,
                  session,
                  persist,
                },
                signal,
              ),
          },
          "grace",
        );
        const result = await lease.promise;
        assertCurrent(scope, session, controller.signal);
        setDerived({ identity, url: result.url });
      };
      void load().catch(() => {});
    }, 100);
    return () => {
      clearTimeout(timer);
      controller.abort();
      lease?.release();
    };
  }, [
    accountId,
    hostId,
    canonicalSourceRoot,
    originalUrl,
    treatment,
    strength,
    identity,
    persist,
  ]);

  return treatment === "dither" &&
    strength > 0 &&
    derived?.identity === identity
    ? derived.url
    : originalUrl;
}
