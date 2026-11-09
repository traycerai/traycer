import { describe, expect, it } from "vitest";
import {
  readOpusPreSkip,
  webmOpusCluster,
  webmOpusHeader,
  type OpusPacket,
} from "../webm-opus";

/** A from-scratch EBML reader, independent of the writer under test. */

const ID = {
  ebml: 0x1a45dfa3,
  ebmlVersion: 0x4286,
  ebmlReadVersion: 0x42f7,
  ebmlMaxIdLength: 0x42f2,
  ebmlMaxSizeLength: 0x42f3,
  docType: 0x4282,
  docTypeVersion: 0x4287,
  docTypeReadVersion: 0x4285,
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  muxingApp: 0x4d80,
  writingApp: 0x5741,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackUid: 0x73c5,
  trackType: 0x83,
  flagLacing: 0x9c,
  codecId: 0x86,
  codecPrivate: 0x63a2,
  codecDelay: 0x56aa,
  seekPreRoll: 0x56bb,
  audio: 0xe1,
  samplingFrequency: 0xb5,
  channels: 0x9f,
  cluster: 0x1f43b675,
  timecode: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
  discardPadding: 0x75a2,
} as const;

/** The containers this reader descends into; every other id is a leaf. */
const CONTAINERS = new Set<number>([
  ID.ebml,
  ID.segment,
  ID.info,
  ID.tracks,
  ID.trackEntry,
  ID.audio,
  ID.cluster,
  ID.blockGroup,
]);

interface Elem {
  readonly id: number;
  readonly bytes: Uint8Array;
  readonly children: Elem[];
}

/** How many bytes the vint at `at` occupies, from its first byte's marker. */
function vintLength(first: number): number {
  let length = 1;
  while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length += 1;
  return length;
}

function readVint(
  bytes: Uint8Array,
  at: number,
  keepMarker: boolean,
): { readonly value: number; readonly length: number } {
  const length = vintLength(bytes[at]);
  let value = keepMarker ? bytes[at] : bytes[at] & (0xff >> length);
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + bytes[at + index];
  }
  return { value, length };
}

/**
 * Whether the vint at `at` is the EBML reserved "unknown size" marker: every
 * content bit, in every byte of its own width, set to 1. Read off the RAW
 * bytes rather than the vint's computed numeric value — an 8-byte vint's
 * content is 56 bits, well past `Number.MAX_SAFE_INTEGER`, so the all-ones
 * case is exactly where a numeric comparison (`size.value === 0xffffffff`,
 * which is only 32 bits of ones, or any other fixed-width numeric constant)
 * is the wrong tool: it is never equal to the real, wider value, by
 * construction, however it is written.
 */
function isUnknownSize(bytes: Uint8Array, at: number): boolean {
  const length = vintLength(bytes[at]);
  const firstPayloadMask = 0xff >> length;
  if ((bytes[at] & firstPayloadMask) !== firstPayloadMask) return false;
  for (let index = 1; index < length; index += 1) {
    if (bytes[at + index] !== 0xff) return false;
  }
  return true;
}

/** Parses one buffer as a flat top-level element list, recursing into containers. */
function parseElements(bytes: Uint8Array, start: number, end: number): Elem[] {
  const out: Elem[] = [];
  let at = start;
  while (at < end) {
    const id = readVint(bytes, at, true);
    const sizeAt = at + id.length;
    const size = readVint(bytes, sizeAt, false);
    const bodyAt = sizeAt + size.length;
    // The Segment is written with the reserved unknown-size marker: its own
    // content runs to the end of the buffer, since this muxer never closes it.
    const unknownSize = id.value === ID.segment && isUnknownSize(bytes, sizeAt);
    const bodyEnd = unknownSize ? end : bodyAt + size.value;
    if (bodyEnd > end) {
      throw new Error(
        `Element at ${String(at)} claims a body past the buffer it is in`,
      );
    }
    const body = bytes.subarray(bodyAt, bodyEnd);
    out.push({
      id: id.value,
      bytes: body,
      children: CONTAINERS.has(id.value)
        ? parseElements(bytes, bodyAt, bodyEnd)
        : [],
    });
    at = bodyEnd;
  }
  return out;
}

function parse(bytes: Uint8Array): Elem[] {
  return parseElements(bytes, 0, bytes.length);
}

function find(elements: readonly Elem[], id: number): Elem | undefined {
  return elements.find((e) => e.id === id);
}

/** `find`, but the element is required: a writer that omitted it is a defect. */
function requiredChild(
  elements: readonly Elem[],
  id: number,
  what: string,
): Elem {
  const found = find(elements, id);
  if (found === undefined) throw new Error(`no ${what}`);
  return found;
}

function uint(bytes: Uint8Array): number {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

function int(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let value = bytes[0] >= 0x80 ? bytes[0] - 256 : bytes[0];
  for (let index = 1; index < bytes.length; index += 1) {
    value = value * 256 + bytes[index];
  }
  return value;
}

function ascii(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function float64(bytes: Uint8Array): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getFloat64(0, false);
}

/** A synthetic but structurally valid `OpusHead`, as the encoder would hand over. */
function opusHead(preSkip: number): Uint8Array {
  const bytes = new Uint8Array(19);
  bytes.set(new TextEncoder().encode("OpusHead"), 0);
  bytes[8] = 1; // version
  bytes[9] = 2; // channel count
  new DataView(bytes.buffer).setUint16(10, preSkip, true);
  return bytes;
}

describe("readOpusPreSkip", () => {
  it("reads the little-endian pre-skip at its fixed offset", () => {
    expect(readOpusPreSkip(opusHead(3840))).toBe(3840);
    expect(readOpusPreSkip(opusHead(0))).toBe(0);
  });

  it("throws on a buffer too short to hold an OpusHead", () => {
    expect(() => readOpusPreSkip(opusHead(0).subarray(0, 18))).toThrow();
  });

  it("throws when the magic is not OpusHead", () => {
    const bad = opusHead(0);
    bad.set(new TextEncoder().encode("NotOpus!"), 0);
    expect(() => readOpusPreSkip(bad)).toThrow();
  });
});

/** The header's own top-level structure, parsed once per test that needs it. */
function parsedHeader(preSkipSamples: number): {
  readonly head: Uint8Array;
  readonly ebml: Elem;
  readonly segment: Elem;
  readonly trackEntry: Elem;
  readonly audio: Elem;
  readonly info: Elem;
} {
  const head = opusHead(preSkipSamples);
  const bytes = webmOpusHeader({ opusHead: head, preSkipSamples });
  const top = parse(bytes);
  const ebml = requiredChild(top, ID.ebml, "EBML header");
  const segment = requiredChild(top, ID.segment, "Segment");
  const tracks = requiredChild(segment.children, ID.tracks, "Tracks");
  const trackEntry = requiredChild(
    tracks.children,
    ID.trackEntry,
    "TrackEntry",
  );
  const audio = requiredChild(trackEntry.children, ID.audio, "Audio");
  const info = requiredChild(segment.children, ID.info, "Info");
  return { head, ebml, segment, trackEntry, audio, info };
}

describe("webmOpusHeader", () => {
  it("writes the EBML header exactly as the format asks for", () => {
    const { ebml } = parsedHeader(312);
    expect(
      uint(requiredChild(ebml.children, ID.ebmlVersion, "EBMLVersion").bytes),
    ).toBe(1);
    expect(
      uint(
        requiredChild(ebml.children, ID.ebmlReadVersion, "EBMLReadVersion")
          .bytes,
      ),
    ).toBe(1);
    expect(
      uint(
        requiredChild(ebml.children, ID.ebmlMaxIdLength, "EBMLMaxIDLength")
          .bytes,
      ),
    ).toBe(4);
    expect(
      uint(
        requiredChild(ebml.children, ID.ebmlMaxSizeLength, "EBMLMaxSizeLength")
          .bytes,
      ),
    ).toBe(8);
    expect(
      ascii(requiredChild(ebml.children, ID.docType, "DocType").bytes),
    ).toBe("webm");
    expect(
      uint(
        requiredChild(ebml.children, ID.docTypeVersion, "DocTypeVersion").bytes,
      ),
    ).toBe(4);
    expect(
      uint(
        requiredChild(
          ebml.children,
          ID.docTypeReadVersion,
          "DocTypeReadVersion",
        ).bytes,
      ),
    ).toBe(2);
  });

  it("writes the one Opus TrackEntry exactly as the real encoder described itself", () => {
    const { head, trackEntry } = parsedHeader(312);
    expect(
      uint(
        requiredChild(trackEntry.children, ID.trackNumber, "TrackNumber").bytes,
      ),
    ).toBe(1);
    expect(
      uint(requiredChild(trackEntry.children, ID.trackUid, "TrackUID").bytes),
    ).toBe(1);
    expect(
      uint(requiredChild(trackEntry.children, ID.trackType, "TrackType").bytes),
    ).toBe(2);
    expect(
      uint(
        requiredChild(trackEntry.children, ID.flagLacing, "FlagLacing").bytes,
      ),
    ).toBe(0);
    expect(
      ascii(requiredChild(trackEntry.children, ID.codecId, "CodecID").bytes),
    ).toBe("A_OPUS");
    expect(
      requiredChild(trackEntry.children, ID.codecPrivate, "CodecPrivate").bytes,
    ).toEqual(head);
    // 312 samples at 48 kHz, in nanoseconds.
    expect(
      uint(
        requiredChild(trackEntry.children, ID.codecDelay, "CodecDelay").bytes,
      ),
    ).toBe(Math.round((312 * 1e9) / 48_000));
    expect(
      uint(
        requiredChild(trackEntry.children, ID.seekPreRoll, "SeekPreRoll").bytes,
      ),
    ).toBe(80_000_000);
  });

  it("writes the track's Audio settings as native 48 kHz stereo", () => {
    const { audio } = parsedHeader(312);
    expect(
      float64(
        requiredChild(audio.children, ID.samplingFrequency, "SamplingFrequency")
          .bytes,
      ),
    ).toBe(48_000);
    expect(
      uint(requiredChild(audio.children, ID.channels, "Channels").bytes),
    ).toBe(2);
  });

  it("writes the Segment's own Info exactly as the format asks for", () => {
    const { info } = parsedHeader(312);
    expect(
      uint(
        requiredChild(info.children, ID.timecodeScale, "TimecodeScale").bytes,
      ),
    ).toBe(1_000); // 1 µs: exact for any whole-microsecond pre-skip
    expect(
      ascii(requiredChild(info.children, ID.muxingApp, "MuxingApp").bytes),
    ).toBe("traycer");
    expect(
      ascii(requiredChild(info.children, ID.writingApp, "WritingApp").bytes),
    ).toBe("traycer");
  });

  it("writes the Segment's size as the reserved unknown-size value, never a real length", () => {
    const bytes = webmOpusHeader({ opusHead: opusHead(0), preSkipSamples: 0 });
    // Right after the EBML header: the Segment id (4 bytes), then the fixed
    // 8-byte unknown-size marker this muxer always writes.
    const segmentAt = bytes.indexOf(0x18);
    expect(Array.from(bytes.subarray(segmentAt, segmentAt + 4))).toEqual([
      0x18, 0x53, 0x80, 0x67,
    ]);
    expect(Array.from(bytes.subarray(segmentAt + 4, segmentAt + 12))).toEqual([
      0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
  });
});

function packet(timeMs: number, byte: number): OpusPacket {
  return { bytes: new Uint8Array([byte]), timeMs };
}

function simpleBlocks(
  cluster: Elem,
): { offset: number; flag: number; byte: number }[] {
  return cluster.children
    .filter((child) => child.id === ID.simpleBlock)
    .map((block) => ({
      offset: new DataView(
        block.bytes.buffer,
        block.bytes.byteOffset + 1,
        2,
      ).getInt16(0, false),
      flag: block.bytes[3],
      byte: block.bytes[4],
    }));
}

describe("webmOpusCluster", () => {
  it("writes the cluster's own timecode and one keyframe SimpleBlock per packet, offset from the first, both in ticks at the 1 µs scale", () => {
    const cluster = parse(
      webmOpusCluster([packet(1000, 0xaa), packet(1020, 0xbb)], null),
    )[0];
    // 1000 ms at 1000 ticks/ms (the 1 µs TimecodeScale).
    expect(
      uint(find(cluster.children, ID.timecode)?.bytes ?? new Uint8Array()),
    ).toBe(1_000_000);
    expect(simpleBlocks(cluster)).toEqual([
      { offset: 0, flag: 0x80, byte: 0xaa },
      { offset: 20_000, flag: 0x80, byte: 0xbb },
    ]);
  });

  it("throws given no packets", () => {
    expect(() => webmOpusCluster([], null)).toThrow();
  });

  it("throws when a block's offset from the cluster's own time is out of the signed 16-bit range", () => {
    expect(() =>
      webmOpusCluster([packet(0, 1), packet(40_000, 2)], null),
    ).toThrow();
  });

  it("refuses a third 20 ms packet in one cluster: two already reach 20,000 of the 32,767 ticks a block offset can hold, and a third needs 40,000", () => {
    expect(() =>
      webmOpusCluster(
        [packet(0, 0xaa), packet(20, 0xbb), packet(40, 0xcc)],
        null,
      ),
    ).toThrow(/ticks into its cluster is out of range/);
  });

  it("carries the final packet's discard padding in a BlockGroup, with no keyframe flag on its Block, and leaves earlier packets as plain SimpleBlocks", () => {
    const cluster = parse(
      webmOpusCluster(
        [packet(0, 0xaa), packet(20, 0xbb)],
        /* finalDiscardPaddingNs */ 5_000_000,
      ),
    )[0];
    expect(simpleBlocks(cluster)).toEqual([
      { offset: 0, flag: 0x80, byte: 0xaa },
    ]);

    const group = find(cluster.children, ID.blockGroup);
    if (group === undefined)
      throw new Error("no BlockGroup for the last packet");
    const block = find(group.children, ID.block);
    if (block === undefined) throw new Error("no Block inside the BlockGroup");
    expect(
      new DataView(block.bytes.buffer, block.bytes.byteOffset + 1, 2).getInt16(
        0,
        false,
      ),
    ).toBe(20_000); // 20 ms at 1000 ticks/ms
    // No keyframe flag: a block inside a BlockGroup is a keyframe by having no
    // ReferenceBlock beside it, not by the flag SimpleBlock uses.
    expect(block.bytes[3]).toBe(0);
    expect(block.bytes[4]).toBe(0xbb);
    expect(
      int(find(group.children, ID.discardPadding)?.bytes ?? new Uint8Array()),
    ).toBe(5_000_000);
  });

  it("writes a single-packet cluster's only block as the padded one when discard padding is given", () => {
    const cluster = parse(webmOpusCluster([packet(0, 0xaa)], 1_000_000))[0];
    expect(simpleBlocks(cluster)).toEqual([]);
    const group = find(cluster.children, ID.blockGroup);
    if (group === undefined) throw new Error("no BlockGroup");
    expect(
      int(find(group.children, ID.discardPadding)?.bytes ?? new Uint8Array()),
    ).toBe(1_000_000);
  });
});
