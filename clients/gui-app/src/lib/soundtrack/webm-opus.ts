/**
 * Just enough Matroska to write one Opus track, a cluster at a time, as the
 * encoder produces it.
 *
 * APPEND-ONLY, and that is the whole shape of it. The Segment's size is the
 * reserved unknown-size value, so nothing before the audio ever has to be
 * revised once it is on disk, and there is no Cues or Duration to go back and
 * fill in: a recording that stops at a crash is a readable file up to its last
 * whole cluster. Every cluster, by contrast, carries its real size, because a
 * reader that meets a second unknown-size element has no way to tell where the
 * first one ended.
 *
 * It is deliberately not a general muxer. One audio track, numbered 1, no
 * lacing, no seek head, Opus only.
 */

/** Element ids, as the byte sequences they are written as. */
const ID = {
  ebml: [0x1a, 0x45, 0xdf, 0xa3],
  ebmlVersion: [0x42, 0x86],
  ebmlReadVersion: [0x42, 0xf7],
  ebmlMaxIdLength: [0x42, 0xf2],
  ebmlMaxSizeLength: [0x42, 0xf3],
  docType: [0x42, 0x82],
  docTypeVersion: [0x42, 0x87],
  docTypeReadVersion: [0x42, 0x85],
  segment: [0x18, 0x53, 0x80, 0x67],
  info: [0x15, 0x49, 0xa9, 0x66],
  timecodeScale: [0x2a, 0xd7, 0xb1],
  muxingApp: [0x4d, 0x80],
  writingApp: [0x57, 0x41],
  tracks: [0x16, 0x54, 0xae, 0x6b],
  trackEntry: [0xae],
  trackNumber: [0xd7],
  trackUid: [0x73, 0xc5],
  trackType: [0x83],
  flagLacing: [0x9c],
  codecId: [0x86],
  codecPrivate: [0x63, 0xa2],
  codecDelay: [0x56, 0xaa],
  seekPreRoll: [0x56, 0xbb],
  audio: [0xe1],
  samplingFrequency: [0xb5],
  channels: [0x9f],
  cluster: [0x1f, 0x43, 0xb6, 0x75],
  timecode: [0xe7],
  simpleBlock: [0xa3],
  blockGroup: [0xa0],
  block: [0xa1],
  discardPadding: [0x75, 0xa2],
} as const;

/**
 * One microsecond, which is what every timestamp here is written in.
 *
 * A millisecond tick is not enough, and that is a decode requirement rather
 * than a resolution preference: a player converts `CodecDelay` into this
 * scale, rounds it to the nearest tick, and trims that many ticks from the
 * front. A pre-skip of 312 samples is 6.5 ms, so on a millisecond tick it
 * rounds to 7 and the decoder throws away 24 samples of real audio, starting
 * the file half a millisecond early. Microseconds are exact for any pre-skip
 * that is a whole number of them.
 */
const TIMECODE_SCALE_NS = 1_000;
/** Ticks in one millisecond, which is the unit a packet states its time in. */
const TICKS_PER_MS = 1_000_000 / TIMECODE_SCALE_NS;
/**
 * A block's offset from its cluster's timecode is a signed 16-bit tick count,
 * and that is what bounds how much audio one cluster can hold. Negative
 * offsets are legal and deliberately unused: a cluster starts at its own first
 * packet, so every offset in it is forward.
 */
const MAX_BLOCK_OFFSET_TICKS = 0x7fff;
const TRACK_NUMBER = 1;
/** `TrackType` 2 is audio. */
const TRACK_TYPE_AUDIO = 2;
const CHANNELS = 2;
const SAMPLE_RATE = 48_000;
/**
 * A reader may need this much audio before the seek point to decode correctly.
 * 80 ms is what the Matroska Opus guidelines state, and it is a property of the
 * codec rather than of this file.
 */
const SEEK_PRE_ROLL_NS = 80_000_000;
/** A `SimpleBlock`'s keyframe flag. Every Opus packet is one. */
const FLAG_KEYFRAME = 0x80;
/** `OpusHead`'s own layout: the magic, then the pre-skip at this offset. */
const OPUS_HEAD_MAGIC = "OpusHead";
const OPUS_HEAD_PRE_SKIP_OFFSET = 10;
const OPUS_HEAD_MIN_BYTES = 19;

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

/** An EBML element's data size: the width in the marker bit, then the length. */
function sizeBytes(length: number): Uint8Array {
  for (let width = 1; width <= 8; width += 1) {
    // The all-ones value of each width is reserved for an unknown size, so a
    // length that reaches it needs the next width up.
    const reserved = 2 ** (7 * width) - 1;
    if (length >= reserved) continue;
    const bytes = new Uint8Array(width);
    let rest = length;
    for (let index = width - 1; index >= 0; index -= 1) {
      bytes[index] = rest % 256;
      rest = Math.floor(rest / 256);
    }
    bytes[0] |= 1 << (8 - width);
    return bytes;
  }
  throw new Error(`webm: an element of ${String(length)} bytes is too long`);
}

/** The shortest big-endian unsigned encoding, which EBML takes for a uint. */
function uintBytes(value: number): Uint8Array {
  const digits: number[] = [];
  let rest = value;
  do {
    digits.unshift(rest % 256);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  return new Uint8Array(digits);
}

/**
 * The shortest big-endian two's-complement encoding. A positive value whose
 * top bit would fall in the sign's place takes a leading zero byte, which is
 * why this cannot be `uintBytes` with a cast.
 */
function intBytes(value: number): Uint8Array {
  let width = 1;
  while (width < 8) {
    const limit = 2 ** (8 * width - 1);
    if (value >= -limit && value < limit) break;
    width += 1;
  }
  const bytes = new Uint8Array(width);
  let rest = value < 0 ? value + 2 ** (8 * width) : value;
  for (let index = width - 1; index >= 0; index -= 1) {
    bytes[index] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return bytes;
}

function element(id: readonly number[], payload: Uint8Array): Uint8Array {
  return concatBytes([new Uint8Array(id), sizeBytes(payload.length), payload]);
}

function uintElement(id: readonly number[], value: number): Uint8Array {
  return element(id, uintBytes(value));
}

function intElement(id: readonly number[], value: number): Uint8Array {
  return element(id, intBytes(value));
}

function stringElement(id: readonly number[], value: string): Uint8Array {
  return element(id, new TextEncoder().encode(value));
}

/** EBML writes a float as either four or eight bytes; this always writes eight. */
function floatElement(id: readonly number[], value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  return element(id, bytes);
}

/**
 * `OpusHead`'s pre-skip: the samples the decoder discards from the front,
 * which the container reports as `CodecDelay` so that a player can line the
 * audio up with everything else.
 *
 * Read from the encoder's own description rather than assumed, because it is
 * the encoder's number and differs between builds.
 */
export function readOpusPreSkip(opusHead: Uint8Array): number {
  if (opusHead.length < OPUS_HEAD_MIN_BYTES) {
    throw new Error(
      `webm: OpusHead is ${String(opusHead.length)} bytes, too short to read`,
    );
  }
  const magic = new TextDecoder().decode(
    opusHead.subarray(0, OPUS_HEAD_MAGIC.length),
  );
  if (magic !== OPUS_HEAD_MAGIC) {
    throw new Error("webm: the encoder's description is not an OpusHead");
  }
  const view = new DataView(
    opusHead.buffer,
    opusHead.byteOffset,
    opusHead.byteLength,
  );
  // Little-endian, unlike everything else here: OpusHead is not an EBML
  // structure, it is the Ogg mapping's own header carried verbatim.
  return view.getUint16(OPUS_HEAD_PRE_SKIP_OFFSET, true);
}

/**
 * Everything before the first cluster: the EBML header, the Segment's own
 * unknown-size header, and the one track.
 *
 * `preSkipSamples` becomes `CodecDelay`, in nanoseconds. A player subtracts it
 * once, which is why the blocks themselves start at zero and are never
 * shifted by it as well.
 */
export function webmOpusHeader(input: {
  readonly opusHead: Uint8Array;
  readonly preSkipSamples: number;
}): Uint8Array {
  const header = element(
    ID.ebml,
    concatBytes([
      uintElement(ID.ebmlVersion, 1),
      uintElement(ID.ebmlReadVersion, 1),
      uintElement(ID.ebmlMaxIdLength, 4),
      uintElement(ID.ebmlMaxSizeLength, 8),
      stringElement(ID.docType, "webm"),
      uintElement(ID.docTypeVersion, 4),
      uintElement(ID.docTypeReadVersion, 2),
    ]),
  );
  const info = element(
    ID.info,
    concatBytes([
      uintElement(ID.timecodeScale, TIMECODE_SCALE_NS),
      stringElement(ID.muxingApp, "traycer"),
      stringElement(ID.writingApp, "traycer"),
    ]),
  );
  const track = element(
    ID.trackEntry,
    concatBytes([
      uintElement(ID.trackNumber, TRACK_NUMBER),
      uintElement(ID.trackUid, TRACK_NUMBER),
      uintElement(ID.trackType, TRACK_TYPE_AUDIO),
      uintElement(ID.flagLacing, 0),
      stringElement(ID.codecId, "A_OPUS"),
      element(ID.codecPrivate, input.opusHead),
      uintElement(
        ID.codecDelay,
        Math.round((input.preSkipSamples * 1e9) / SAMPLE_RATE),
      ),
      uintElement(ID.seekPreRoll, SEEK_PRE_ROLL_NS),
      element(
        ID.audio,
        concatBytes([
          floatElement(ID.samplingFrequency, SAMPLE_RATE),
          uintElement(ID.channels, CHANNELS),
        ]),
      ),
    ]),
  );
  return concatBytes([
    header,
    // The Segment, opened and never closed: its id, then the reserved
    // unknown-size value, and from here on everything is appended inside it.
    new Uint8Array(ID.segment),
    new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    element(ID.tracks, track),
    info,
  ]);
}

/** One Opus packet, with where it belongs in the file. */
export interface OpusPacket {
  readonly bytes: Uint8Array;
  /** Whole milliseconds from the start of the file. */
  readonly timeMs: number;
}

/**
 * One finite cluster. Its first packet's time is the cluster's, and each block
 * is written relative to that as a tick count, which is what bounds how many
 * packets a caller may put in one: at this scale two 20 ms packets reach
 * 20,000 of the 32,767 ticks an offset can express and a third would not fit.
 *
 * `finalDiscardPaddingNs` is for the LAST cluster of a file: the encoder pads
 * its last packet out to a whole frame, and this is how many nanoseconds of
 * that packet a player must throw away. It needs a `BlockGroup`, because a
 * `SimpleBlock` has nowhere to carry it.
 */
export function webmOpusCluster(
  packets: readonly OpusPacket[],
  finalDiscardPaddingNs: number | null,
): Uint8Array {
  const first = packets.at(0);
  if (first === undefined) {
    throw new Error("webm: a cluster needs at least one packet");
  }
  const parts: Uint8Array[] = [
    uintElement(ID.timecode, first.timeMs * TICKS_PER_MS),
  ];
  packets.forEach((packet, index) => {
    const offset = (packet.timeMs - first.timeMs) * TICKS_PER_MS;
    if (offset < 0 || offset > MAX_BLOCK_OFFSET_TICKS) {
      throw new Error(
        `webm: a block ${String(offset)} ticks into its cluster is out of range`,
      );
    }
    const last = index === packets.length - 1;
    const padded = last && finalDiscardPaddingNs !== null;
    const head = new Uint8Array(4);
    // The track number is itself a VINT; track 1 is one byte.
    head[0] = 0x80 | TRACK_NUMBER;
    new DataView(head.buffer).setInt16(1, offset, false);
    // A block inside a BlockGroup carries no keyframe flag: it is a keyframe
    // by having no ReferenceBlock beside it.
    head[3] = padded ? 0 : FLAG_KEYFRAME;
    const body = concatBytes([head, packet.bytes]);
    if (!padded) {
      parts.push(element(ID.simpleBlock, body));
      return;
    }
    parts.push(
      element(
        ID.blockGroup,
        concatBytes([
          element(ID.block, body),
          intElement(ID.discardPadding, finalDiscardPaddingNs),
        ]),
      ),
    );
  });
  return element(ID.cluster, concatBytes(parts));
}
