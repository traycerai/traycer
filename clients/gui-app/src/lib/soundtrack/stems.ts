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

function decodedBytes(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * BYTES_PER_FLOAT_SAMPLE;
}

interface LocatedStem {
  /** Stays the same when a link is reissued, and is safe to log, as a url is not. */
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
  return { path, url };
}

/**
 * Stems named by a manifest, fetched and decoded on first use. One that fails
 * is not remembered, so a later play of that sample tries it again. A link the
 * bucket refuses is asked for again once, and the sample retried on the answer:
 * every stem not yet decoded expires together, so they share the one re-ask.
 */
export class ManifestStemSource implements StemSource {
  private manifest: StemManifest;
  private readonly decoder: StemDecoder;
  private readonly reissue: StemReissue;
  private reissuing: Promise<boolean> | null = null;
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
    this.decoder = decoder;
    this.reissue = reissue;
  }

  async load(
    track: VariableTrack,
    layer: Layer,
    variant: number,
  ): Promise<AudioBuffer> {
    const { path, url } = locateStem(this.manifest, track.name, layer, variant);
    const cached = this.decoded.get(path);
    if (cached !== undefined) {
      this.decoded.delete(path);
      this.decoded.set(path, cached);
      return cached;
    }
    const existing = this.inFlight.get(path);
    if (existing !== undefined) return existing;
    const loading = this.fetchAndDecode(path, url, () =>
      locateStem(this.manifest, track.name, layer, variant),
    ).finally(() => {
      this.inFlight.delete(path);
    });
    this.inFlight.set(path, loading);
    return loading;
  }

  private async fetchAndDecode(
    path: string,
    url: string,
    relocate: () => LocatedStem,
  ): Promise<AudioBuffer> {
    let response = await fetch(url);
    if (REFUSED_LINK_STATUSES.has(response.status) && (await this.reissued())) {
      response = await fetch(relocate().url);
    }
    if (!response.ok) {
      throw new Error(
        `Fetching the stem ${path} answered ${String(response.status)}`,
      );
    }
    const buffer = await this.decoder.decode(await response.arrayBuffer());
    this.remember(path, buffer);
    return buffer;
  }

  /** Whether the manifest now holds fresh links. */
  private reissued(): Promise<boolean> {
    this.reissuing ??= this.reissue()
      .then((manifest) => {
        if (manifest === null) return false;
        this.manifest = manifest;
        return true;
      })
      .finally(() => {
        this.reissuing = null;
      });
    return this.reissuing;
  }

  private remember(path: string, buffer: AudioBuffer): void {
    this.decoded.set(path, buffer);
    this.decodedTotalBytes += decodedBytes(buffer);
    for (const [oldestPath, oldest] of this.decoded) {
      if (this.decodedTotalBytes <= MAX_DECODED_BYTES) break;
      if (oldestPath === path) break;
      this.decoded.delete(oldestPath);
      this.decodedTotalBytes -= decodedBytes(oldest);
    }
  }
}
