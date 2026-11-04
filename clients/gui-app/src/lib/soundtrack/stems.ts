import { appLogger } from "@/lib/logger";
import { spanOf } from "./variant-groups";
import type { Layer, VariableTrack } from "./variable-sound";

export interface StemSource {
  /** Rejects when the sample cannot be had; the player skips it and goes on. */
  load(
    track: VariableTrack,
    layer: Layer,
    variant: number,
  ): Promise<AudioBuffer>;
}

export interface StemDecoder {
  decode(bytes: ArrayBuffer): Promise<AudioBuffer>;
}

/** Asks again for the stems of a session whose links stopped working. */
export type StemReissue = () => Promise<StemManifest | null>;

/** One url per variant: `files[0]` is variant 1. */
type StemFiles = readonly string[];

/**
 * A layer's stems, or an intro's or outro's under its name: one list for a
 * pooled layer, one per group for a grouped one, so that a grouped variant is
 * found as `<layer>/<group>/<variant>`.
 */
type StemManifestLayer =
  | {
      readonly name: string;
      readonly files: StemFiles;
      readonly groups?: never;
    }
  | {
      readonly name: string;
      readonly files?: never;
      readonly groups: readonly {
        readonly name: string;
        readonly files: StemFiles;
      }[];
    };

export interface StemManifest {
  readonly tracks: readonly {
    readonly name: string;
    readonly layers: readonly StemManifestLayer[];
  }[];
}

// Decoded stems are large, and a soundtrack runs for days: aquilo-1 alone
// decodes to 335 MiB (996 s of 44.1 kHz stereo floats). This holds one whole
// track and part of the next, and an evicted stem only costs a decode. That
// decode may land its sample a tick or two late, which the grid absorbs.
const MAX_DECODED_BYTES = 512 * 1024 * 1024;
const BYTES_PER_FLOAT_SAMPLE = 4;

/**
 * What Cloud Storage answers a signed link it will not honour. A link past its
 * hour answers 400 `ExpiredToken`, not 403, as a read of the real bucket shows:
 * dropping 400 here would leave a session unable to recover from expiry. 403 is
 * a signature that no longer stands.
 */
const REFUSED_LINK_STATUSES: ReadonlySet<number> = new Set([400, 403]);

/**
 * A signed link works for an hour and names the service account, so it stays
 * out of Chromium's disk cache. That costs nothing: a link changes every
 * session, so the HTTP cache could never hit across them, and within a session
 * `decoded` is the cache.
 */
const NOT_STORED: RequestInit = { cache: "no-store" };

function decodedBytes(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * BYTES_PER_FLOAT_SAMPLE;
}

interface LocatedStem {
  /** Names the stem in the cache, and stays the same when a link is reissued. */
  readonly key: string;
  /** Names it in a message, as a url must not: a link is a credential. */
  readonly path: string;
  readonly url: string;
}

function locateStem(
  manifest: StemManifest,
  trackName: string,
  layer: Layer,
  variant: number,
): LocatedStem {
  const entry = manifest.tracks
    .find((track) => track.name === trackName)
    ?.layers.find((candidate) => candidate.name === layer.name);
  const { group, first } = spanOf(layer, variant);
  const files =
    group === null
      ? entry?.files
      : entry?.groups?.find((candidate) => candidate.name === group)?.files;
  const inFiles = variant - first + 1;
  const url = files?.[inFiles - 1];
  const path = [trackName, layer.name, group, String(inFiles)]
    .filter((part) => part !== null)
    .join("/");
  if (url === undefined) {
    throw new Error(`The stem manifest has no file for ${path}`);
  }
  return {
    key: JSON.stringify([trackName, layer.name, group, variant]),
    path,
    url,
  };
}

/**
 * What a manifest's links point at, whoever signed them and whenever. Blobs are
 * named by their content, so a changed sample is a changed path, and one source
 * reads one set, so the bucket and the set are the same on both sides.
 */
function catalogOf(manifest: StemManifest): string {
  return JSON.stringify(manifest, (_key, value: unknown) => {
    if (typeof value !== "string") return value;
    const query = value.indexOf("?");
    return query === -1 ? value : value.slice(0, query);
  });
}

/**
 * Stems named by a manifest, fetched and decoded on first use. One that fails
 * is not remembered, so a later play of that sample tries it again. A link the
 * bucket refuses is asked for again once, and the sample retried on the answer:
 * every stem not yet decoded expires together, so they share the one re-ask.
 *
 * A session's catalog does not change under it. The published set can, so a
 * re-ask is taken only if it points at exactly the stems the session has, and
 * after one that does not, the session plays what it has decoded and asks no
 * more.
 */
export class ManifestStemSource implements StemSource {
  private manifest: StemManifest;
  private readonly catalog: string;
  private readonly decoder: StemDecoder;
  private readonly reissue: StemReissue;
  private reissuing: Promise<boolean> | null = null;
  private setChanged = false;
  private readonly inFlight = new Map<string, Promise<AudioBuffer>>();
  /** Least recently used first: a Map iterates in insertion order. */
  private readonly decoded = new Map<string, AudioBuffer>();
  private decodedTotalBytes = 0;

  constructor(
    manifest: StemManifest,
    decoder: StemDecoder,
    reissue: StemReissue,
  ) {
    this.manifest = manifest;
    this.catalog = catalogOf(manifest);
    this.decoder = decoder;
    this.reissue = reissue;
  }

  async load(
    track: VariableTrack,
    layer: Layer,
    variant: number,
  ): Promise<AudioBuffer> {
    const stem = locateStem(this.manifest, track.name, layer, variant);
    const cached = this.decoded.get(stem.key);
    if (cached !== undefined) {
      this.decoded.delete(stem.key);
      this.decoded.set(stem.key, cached);
      return cached;
    }
    const existing = this.inFlight.get(stem.key);
    if (existing !== undefined) return existing;
    const loading = this.fetchAndDecode(
      stem,
      () => locateStem(this.manifest, track.name, layer, variant).url,
    ).finally(() => {
      this.inFlight.delete(stem.key);
    });
    this.inFlight.set(stem.key, loading);
    return loading;
  }

  private async fetchAndDecode(
    stem: LocatedStem,
    currentUrl: () => string,
  ): Promise<AudioBuffer> {
    let response = await fetch(stem.url, NOT_STORED);
    if (REFUSED_LINK_STATUSES.has(response.status)) {
      // A slow refusal can land after another stem's re-ask has already
      // replaced this link, and then the fresh link is all it needs.
      if (currentUrl() !== stem.url || (await this.reissued())) {
        response = await fetch(currentUrl(), NOT_STORED);
      }
    }
    if (!response.ok) {
      throw new Error(
        `Fetching the stem ${stem.path} answered ${String(response.status)}`,
      );
    }
    const buffer = await this.decoder.decode(await response.arrayBuffer());
    this.remember(stem.key, buffer);
    return buffer;
  }

  /** Whether the manifest now holds fresh links to the same stems. */
  private reissued(): Promise<boolean> {
    if (this.setChanged) return Promise.resolve(false);
    this.reissuing ??= this.reissue()
      .then((manifest) => {
        if (manifest === null) return false;
        if (catalogOf(manifest) !== this.catalog) {
          this.setChanged = true;
          appLogger.warn(
            "[soundtrack] the published set changed; restart the soundtrack to hear it",
            {},
          );
          return false;
        }
        this.manifest = manifest;
        return true;
      })
      .finally(() => {
        this.reissuing = null;
      });
    return this.reissuing;
  }

  private remember(key: string, buffer: AudioBuffer): void {
    this.decoded.set(key, buffer);
    this.decodedTotalBytes += decodedBytes(buffer);
    for (const [oldestKey, oldest] of this.decoded) {
      if (this.decodedTotalBytes <= MAX_DECODED_BYTES) break;
      if (oldestKey === key) break;
      this.decoded.delete(oldestKey);
      this.decodedTotalBytes -= decodedBytes(oldest);
    }
  }
}
