import type { SoundtrackOutput } from "./output";
import type { Layer, VariableTrack } from "./variable-sound";

export interface StemSource {
  /** Rejects when the sample cannot be had; the player skips it and goes on. */
  load(
    track: VariableTrack,
    layer: Layer,
    variant: number,
  ): Promise<AudioBuffer>;
}

export interface StemManifest {
  readonly tracks: readonly {
    readonly name: string;
    readonly layers: readonly {
      readonly name: string;
      /** One url per variant: `files[0]` is variant 1. */
      readonly files: readonly string[];
    }[];
  }[];
}

// Decoded stems are large, and a soundtrack runs for days: aquilo-1 alone
// decodes to 335 MiB (996 s of 44.1 kHz stereo floats). This holds one whole
// track and part of the next, and an evicted stem only costs a decode. That
// decode may land its sample a tick or two late, which the grid absorbs.
const MAX_DECODED_BYTES = 512 * 1024 * 1024;
const BYTES_PER_FLOAT_SAMPLE = 4;

function decodedBytes(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * BYTES_PER_FLOAT_SAMPLE;
}

function stemUrl(
  manifest: StemManifest,
  trackName: string,
  layerName: string,
  variant: number,
): string {
  const url = manifest.tracks
    .find((track) => track.name === trackName)
    ?.layers.find((layer) => layer.name === layerName)?.files[variant - 1];
  if (url === undefined) {
    throw new Error(
      `The stem manifest has no file for ${trackName}/${layerName}/${String(variant)}`,
    );
  }
  return url;
}

/**
 * Stems named by a manifest, fetched and decoded on first use. One that fails
 * is not remembered, so a later play of that sample tries it again.
 */
export class ManifestStemSource implements StemSource {
  private readonly manifest: StemManifest;
  private readonly decoder: Pick<SoundtrackOutput, "decode">;
  private readonly inFlight = new Map<string, Promise<AudioBuffer>>();
  /** Least recently used first: a Map iterates in insertion order. */
  private readonly decoded = new Map<string, AudioBuffer>();
  private decodedTotalBytes = 0;

  constructor(
    manifest: StemManifest,
    decoder: Pick<SoundtrackOutput, "decode">,
  ) {
    this.manifest = manifest;
    this.decoder = decoder;
  }

  async load(
    track: VariableTrack,
    layer: Layer,
    variant: number,
  ): Promise<AudioBuffer> {
    const url = stemUrl(this.manifest, track.name, layer.name, variant);
    const cached = this.decoded.get(url);
    if (cached !== undefined) {
      this.decoded.delete(url);
      this.decoded.set(url, cached);
      return cached;
    }
    const existing = this.inFlight.get(url);
    if (existing !== undefined) return existing;
    const loading = this.fetchAndDecode(url).finally(() => {
      this.inFlight.delete(url);
    });
    this.inFlight.set(url, loading);
    return loading;
  }

  private async fetchAndDecode(url: string): Promise<AudioBuffer> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Fetching a stem answered ${String(response.status)}: ${url}`,
      );
    }
    const buffer = await this.decoder.decode(await response.arrayBuffer());
    this.remember(url, buffer);
    return buffer;
  }

  private remember(url: string, buffer: AudioBuffer): void {
    this.decoded.set(url, buffer);
    this.decodedTotalBytes += decodedBytes(buffer);
    for (const [oldestUrl, oldest] of this.decoded) {
      if (this.decodedTotalBytes <= MAX_DECODED_BYTES) break;
      if (oldestUrl === url) break;
      this.decoded.delete(oldestUrl);
      this.decodedTotalBytes -= decodedBytes(oldest);
    }
  }
}
