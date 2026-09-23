import { describe, expect, it } from "vitest";
import {
  compareTranscriptRowOrder,
  decodeTranscriptRowOrder,
  encodeTranscriptRowOrder,
  TRANSCRIPT_ROW_ORDER_KEY_LENGTH,
  type TranscriptRowOrder,
} from "@traycer/protocol/persistence/chat-transcript/row-projection-fold-state";

/**
 * The order-key codec: a `TranscriptRowOrder` round-trips through
 * `encodeTranscriptRowOrder` / `decodeTranscriptRowOrder`, and the encoded
 * string's BYTE order agrees with `compareTranscriptRowOrder` - which is the
 * whole point of encoding it, since a store keeps ordinals as
 * `ROW_NUMBER() OVER (ORDER BY order_key)` over the TEXT column.
 */

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const EDGE_FLOATS: readonly number[] = [
  0,
  -0,
  1,
  -1,
  0.5,
  -0.5,
  1.5,
  -1.5,
  123.456,
  -123.456,
  1e-300,
  -1e-300,
  1e300,
  -1e300,
  Number.MAX_SAFE_INTEGER,
  -Number.MAX_SAFE_INTEGER,
  Number.MIN_VALUE, // smallest positive subnormal
  -Number.MIN_VALUE,
  5e-324, // smallest positive subnormal, spelled out
  Number.EPSILON,
];

function order(input: {
  readonly section?: number;
  readonly createdAt: number;
  readonly pass?: number;
  readonly position: number;
  readonly entry?: number;
  readonly slot?: number;
  readonly card?: number;
}): TranscriptRowOrder {
  return {
    section: input.section ?? 0,
    createdAt: input.createdAt,
    pass: input.pass ?? 0,
    position: input.position,
    entry: input.entry ?? 0,
    slot: input.slot ?? 0,
    card: input.card ?? 0,
  };
}

describe("encodeTranscriptRowOrder / decodeTranscriptRowOrder roundtrip", () => {
  it("roundtrips createdAt over edge floats", () => {
    for (const value of EDGE_FLOATS) {
      const encoded = encodeTranscriptRowOrder(
        order({ createdAt: value, position: 0 }),
      );
      const decoded = decodeTranscriptRowOrder(encoded);
      // `-0` is folded to `0` by the encoder (the comparator treats them
      // equal), so it is excluded from the exact-value check and covered by
      // the ordering assertion below instead.
      if (!Object.is(value, -0)) {
        expect(decoded.createdAt, `createdAt=${value}`).toBe(value);
      }
    }
  });

  it("roundtrips position over edge floats", () => {
    for (const value of EDGE_FLOATS) {
      const encoded = encodeTranscriptRowOrder(
        order({ createdAt: 0, position: value }),
      );
      const decoded = decodeTranscriptRowOrder(encoded);
      if (!Object.is(value, -0)) {
        expect(decoded.position, `position=${value}`).toBe(value);
      }
    }
  });

  it("roundtrips every integer component (section, pass, entry, slot, card)", () => {
    const sample = order({
      section: 2,
      createdAt: 1_700_000_000_000,
      pass: 5,
      position: 987_654,
      entry: 0xffffff,
      slot: 1,
      card: 0xabcdef,
    });
    const decoded = decodeTranscriptRowOrder(encodeTranscriptRowOrder(sample));
    expect(decoded).toEqual(sample);
  });

  it("treats -0 and 0 as equal after roundtrip", () => {
    const negativeZero = decodeTranscriptRowOrder(
      encodeTranscriptRowOrder(order({ createdAt: -0, position: -0 })),
    );
    const positiveZero = decodeTranscriptRowOrder(
      encodeTranscriptRowOrder(order({ createdAt: 0, position: 0 })),
    );
    expect(negativeZero).toEqual(positiveZero);
  });

  it("produces a key of exactly TRANSCRIPT_ROW_ORDER_KEY_LENGTH, lowercase hex only", () => {
    const r = rng(7);
    for (let i = 0; i < 500; i += 1) {
      const sample = order({
        section: Math.floor(r() * 4),
        createdAt: (r() - 0.5) * 2 ** (Math.floor(r() * 60) - 20),
        pass: Math.floor(r() * 16),
        position: (r() - 0.5) * 2 ** (Math.floor(r() * 60) - 20),
        entry: Math.floor(r() * 0xffffffff),
        slot: Math.floor(r() * 16),
        card: Math.floor(r() * 0xffffffff),
      });
      const encoded = encodeTranscriptRowOrder(sample);
      expect(encoded.length, `sample ${i}`).toBe(
        TRANSCRIPT_ROW_ORDER_KEY_LENGTH,
      );
      expect(encoded, `sample ${i}`).toMatch(/^[0-9a-f]+$/);
    }
  });

  it("rejects a malformed key", () => {
    expect(() => decodeTranscriptRowOrder("")).toThrow();
    expect(() =>
      decodeTranscriptRowOrder("z".repeat(TRANSCRIPT_ROW_ORDER_KEY_LENGTH)),
    ).toThrow();
    expect(() =>
      decodeTranscriptRowOrder("0".repeat(TRANSCRIPT_ROW_ORDER_KEY_LENGTH - 1)),
    ).toThrow();
  });

  it("string order equals compareTranscriptRowOrder over many random pairs", () => {
    const r = rng(42);
    const randomOrder = (): TranscriptRowOrder =>
      order({
        section: Math.floor(r() * 3),
        createdAt: (r() - 0.5) * 2 ** (Math.floor(r() * 100) - 50),
        pass: Math.floor(r() * 6),
        position: (r() - 0.5) * 2 ** (Math.floor(r() * 100) - 50),
        entry: Math.floor(r() * 0xffffff),
        slot: Math.floor(r() * 2),
        card: Math.floor(r() * 0xffffff),
      });

    for (let i = 0; i < 2000; i += 1) {
      const a = randomOrder();
      const b = randomOrder();
      const comparatorSign = Math.sign(compareTranscriptRowOrder(a, b));
      const keyA = encodeTranscriptRowOrder(a);
      const keyB = encodeTranscriptRowOrder(b);
      const stringSign = keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
      expect(
        stringSign,
        `pair ${i}: a=${JSON.stringify(a)} b=${JSON.stringify(b)}`,
      ).toBe(comparatorSign);
    }
  });

  it("sorting a list by encoded key equals sorting by compareTranscriptRowOrder", () => {
    const r = rng(99);
    const orders: TranscriptRowOrder[] = [];
    for (let i = 0; i < 300; i += 1) {
      orders.push(
        order({
          section: Math.floor(r() * 3),
          createdAt: Math.floor(r() * 1_000_000),
          pass: Math.floor(r() * 6),
          position: Math.floor(r() * 1_000_000),
          entry: Math.floor(r() * 1000),
          slot: Math.floor(r() * 2),
          card: Math.floor(r() * 1000),
        }),
      );
    }
    const byComparator = [...orders].sort(compareTranscriptRowOrder);
    const byEncodedKey = [...orders]
      .map((value) => ({ value, key: encodeTranscriptRowOrder(value) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((entry) => entry.value);
    expect(byEncodedKey).toEqual(byComparator);
  });
});
