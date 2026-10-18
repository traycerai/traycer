import { describe, expect, it } from "vitest";
import {
  DATA_MAINTENANCE_MAX_FRAME_BYTES,
  MaintenanceFrameDecoder,
  MaintenanceFrameError,
  encodeMaintenanceFrame,
  progressFrame,
  requestFrame,
  type MaintenanceFrame,
} from "../data-maintenance-channel";

const REQUEST: MaintenanceFrame = requestFrame({
  version: 1,
  migrationId: "m-12345678",
  journalRevision: 3,
  operation: "inventory",
  inventoryDigest: null,
  authorization: { pid: 42, startIdentity: null, lockNonce: "nonce" },
});

function rawFrame(
  magic: string,
  payload: Buffer,
  declaredLength: number,
): Buffer {
  const header = Buffer.alloc(8);
  header.write(magic, 0, "ascii");
  header.writeUInt32BE(declaredLength, 4);
  return Buffer.concat([header, payload]);
}

function jsonFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  return rawFrame("TRM1", payload, payload.length);
}

describe("maintenance channel framing", () => {
  it("round-trips several frames in one chunk", () => {
    const frames = [REQUEST, progressFrame("repair-copy", 1, 4)];
    const decoder = new MaintenanceFrameDecoder();
    const decoded = decoder.push(
      Buffer.concat(frames.map((frame) => encodeMaintenanceFrame(frame))),
    );
    expect(decoded).toEqual(frames);
    expect(decoder.pendingBytes).toBe(0);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("reassembles a frame split into one-byte chunks", () => {
    const bytes = encodeMaintenanceFrame(REQUEST);
    const decoder = new MaintenanceFrameDecoder();
    const out: MaintenanceFrame[] = [];
    for (const byte of bytes) out.push(...decoder.push(Buffer.from([byte])));
    expect(out).toEqual([REQUEST]);
  });

  it("rejects a frame without the channel magic", () => {
    const decoder = new MaintenanceFrameDecoder();
    expect(() => decoder.push(rawFrame("XXXX", Buffer.from("{}"), 2))).toThrow(
      MaintenanceFrameError,
    );
  });

  it("rejects an oversize declared length before buffering the payload", () => {
    const decoder = new MaintenanceFrameDecoder();
    expect(() =>
      decoder.push(
        rawFrame("TRM1", Buffer.alloc(0), DATA_MAINTENANCE_MAX_FRAME_BYTES + 1),
      ),
    ).toThrow(/limit/u);
  });

  it("rejects a non-JSON payload", () => {
    const payload = Buffer.from("not json");
    const decoder = new MaintenanceFrameDecoder();
    expect(() =>
      decoder.push(rawFrame("TRM1", payload, payload.length)),
    ).toThrow(/not JSON/u);
  });

  it("rejects JSON that does not match the schema", () => {
    const decoder = new MaintenanceFrameDecoder();
    expect(() => decoder.push(jsonFrame({ kind: "nope" }))).toThrow(/schema/u);
  });

  it("finish throws when the stream ended inside a frame, and passes on a clean end", () => {
    const bytes = encodeMaintenanceFrame(REQUEST);
    const truncated = new MaintenanceFrameDecoder();
    expect(truncated.push(bytes.subarray(0, bytes.length - 1))).toEqual([]);
    expect(() => truncated.finish()).toThrow(/inside a frame/u);

    const clean = new MaintenanceFrameDecoder();
    clean.push(bytes);
    expect(() => clean.finish()).not.toThrow();
  });

  it("is poisoned after an error: even a valid frame is refused", () => {
    const decoder = new MaintenanceFrameDecoder();
    expect(() => decoder.push(jsonFrame({ kind: "nope" }))).toThrow(
      MaintenanceFrameError,
    );
    expect(() => decoder.push(encodeMaintenanceFrame(REQUEST))).toThrow(
      /already failed/u,
    );
    expect(() => decoder.finish()).toThrow(/already failed/u);
    // A fresh decoder accepts the same bytes: the refusal is the poisoning.
    expect(
      new MaintenanceFrameDecoder().push(encodeMaintenanceFrame(REQUEST)),
    ).toEqual([REQUEST]);
  });
});
