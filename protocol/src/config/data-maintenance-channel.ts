import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  maintenanceRequestSchema,
  maintenanceResponseSchema,
  type MaintenanceOperation,
  type MaintenanceRequest,
  type MaintenanceResponse,
} from "./data-migration-contracts";

/**
 * The private channel between the migration coordinator (the CLI) and the
 * host's offline `data-maintenance` role (design: issue-718 "Offline
 * maintenance interface"). The coordinator spawns the host executable with an
 * argument array - never shell text - and talks over the child's own stdin and
 * stdout pipes: one request frame in, any number of progress frames and
 * exactly one final frame out. There is no socket, port or HTTP endpoint.
 *
 * Frame: 4-byte magic `TRM1`, 4-byte big-endian payload length, UTF-8 JSON
 * payload. The magic makes a stray write on the pipe (a dependency printing
 * to stdout) a framing error instead of a misread message. Node-only
 * (`Buffer`), so subpath-only like the rest of `config/`.
 */

export const DATA_MAINTENANCE_ROLE_ARG = "--traycer-data-maintenance";

const FRAME_MAGIC = Buffer.from("TRM1", "ascii");
const HEADER_BYTES = 8;
/** Far above any inventory this channel carries; bounds a corrupt length. */
export const DATA_MAINTENANCE_MAX_FRAME_BYTES = 64 * 1024 * 1024;

export const maintenanceProgressSchema = lazySchema(() =>
  z.strictObject({
    operation: z.enum([
      "inventory",
      "verify-quiesced-source",
      "repair-copy",
      "verify-copy",
    ]),
    completedStores: z.number().int().nonnegative(),
    totalStores: z.number().int().nonnegative(),
  }),
);
export type MaintenanceProgress = z.infer<typeof maintenanceProgressSchema>;

export const maintenanceFrameSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("request"),
      request: maintenanceRequestSchema,
    }),
    z.strictObject({
      kind: z.literal("progress"),
      progress: maintenanceProgressSchema,
    }),
    z.strictObject({
      kind: z.literal("response"),
      response: maintenanceResponseSchema,
    }),
    /**
     * The request could not be read at all (bad framing, schema, or an
     * internal failure before any response could be built). Carries no paths.
     */
    z.strictObject({
      kind: z.literal("fatal"),
      code: z.enum(["bad-frame", "bad-request", "internal"]),
      message: z.string(),
    }),
  ]),
);
export type MaintenanceFrame = z.infer<typeof maintenanceFrameSchema>;

export class MaintenanceFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaintenanceFrameError";
  }
}

export function encodeMaintenanceFrame(frame: MaintenanceFrame): Buffer {
  const payload = Buffer.from(
    JSON.stringify(maintenanceFrameSchema.parse(frame)),
    "utf8",
  );
  if (payload.length > DATA_MAINTENANCE_MAX_FRAME_BYTES) {
    throw new MaintenanceFrameError(
      "maintenance frame exceeds the channel limit",
    );
  }
  const header = Buffer.alloc(HEADER_BYTES);
  FRAME_MAGIC.copy(header, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/**
 * Incremental decoder for one direction of the pipe. `push` returns every
 * complete frame the bytes so far contain and throws on a framing or schema
 * violation; after a throw the decoder is poisoned (a pipe that carried one
 * corrupt frame cannot be resynchronized safely).
 */
export class MaintenanceFrameDecoder {
  private buffered: Buffer = Buffer.alloc(0);
  private poisoned = false;

  push(chunk: Buffer): MaintenanceFrame[] {
    if (this.poisoned)
      throw new MaintenanceFrameError("maintenance channel already failed");
    this.buffered =
      this.buffered.length === 0
        ? chunk
        : Buffer.concat([this.buffered, chunk]);
    const frames: MaintenanceFrame[] = [];
    try {
      for (;;) {
        if (this.buffered.length < HEADER_BYTES) break;
        if (!this.buffered.subarray(0, 4).equals(FRAME_MAGIC)) {
          throw new MaintenanceFrameError(
            "maintenance frame has no channel magic",
          );
        }
        const length = this.buffered.readUInt32BE(4);
        if (length > DATA_MAINTENANCE_MAX_FRAME_BYTES) {
          throw new MaintenanceFrameError(
            "maintenance frame exceeds the channel limit",
          );
        }
        if (this.buffered.length < HEADER_BYTES + length) break;
        const payload = this.buffered.subarray(
          HEADER_BYTES,
          HEADER_BYTES + length,
        );
        this.buffered = this.buffered.subarray(HEADER_BYTES + length);
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload.toString("utf8"));
        } catch {
          throw new MaintenanceFrameError("maintenance frame is not JSON");
        }
        const frame = maintenanceFrameSchema.safeParse(parsed);
        if (!frame.success) {
          throw new MaintenanceFrameError(
            "maintenance frame does not match the channel schema",
          );
        }
        frames.push(frame.data);
      }
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
    return frames;
  }

  /** Bytes received after the last complete frame. */
  get pendingBytes(): number {
    return this.buffered.length;
  }

  /**
   * The stream ended. Throws when it ended inside a frame (a truncated header
   * or payload): a partial final frame is a failure, never a shorter message.
   */
  finish(): void {
    if (this.poisoned)
      throw new MaintenanceFrameError("maintenance channel already failed");
    if (this.buffered.length > 0) {
      this.poisoned = true;
      throw new MaintenanceFrameError(
        "maintenance channel ended inside a frame",
      );
    }
  }
}

export function requestFrame(request: MaintenanceRequest): MaintenanceFrame {
  return { kind: "request", request };
}

export function responseFrame(response: MaintenanceResponse): MaintenanceFrame {
  return { kind: "response", response };
}

export function progressFrame(
  operation: MaintenanceOperation,
  completedStores: number,
  totalStores: number,
): MaintenanceFrame {
  return {
    kind: "progress",
    progress: { operation, completedStores, totalStores },
  };
}
