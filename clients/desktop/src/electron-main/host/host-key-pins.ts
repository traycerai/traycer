import { app } from "electron";
import { join } from "node:path";
import { z } from "zod";
import { describeLogError, log } from "../app/logger";
import { createJsonFileStore } from "../app/json-file-store";
import {
  installHostKeyPinStore,
  type HostKeyPinMismatchError,
  type HostKeyPinStore,
} from "@traycer-clients/shared/host-client/host-key-pin";
import type { HostKeyPinMismatch } from "../../ipc-contracts/platform-types";

const STORE_FILE_NAME = "host-key-pins.json";

/** A refusal with no emitter is logged; the host is refused either way. */
let mismatchEmitter: ((entry: HostKeyPinMismatch) => void) | null = null;

export function setHostKeyPinMismatchEmitter(
  emitter: (entry: HostKeyPinMismatch) => void,
): void {
  mismatchEmitter = emitter;
}

const payloadSchema = z.object({
  pins: z.record(z.string(), z.string()).catch({}),
});

type Payload = z.infer<typeof payloadSchema>;

const FALLBACK: Payload = { pins: {} };

function parsePayload(value: unknown): Payload {
  const parsed = payloadSchema.safeParse(value);
  return parsed.success ? parsed.data : FALLBACK;
}

export function installDesktopHostKeyPins(): void {
  const filePath = join(app.getPath("userData"), STORE_FILE_NAME);
  const file = createJsonFileStore<Payload>(filePath, FALLBACK, parsePayload);
  let pins: Promise<Record<string, string>> | null = null;

  const loaded = (): Promise<Record<string, string>> => {
    pins ??= file.load().then((payload) => ({ ...payload.pins }));
    return pins;
  };

  const store: HostKeyPinStore = {
    async read(hostId) {
      return (await loaded())[hostId] ?? null;
    },
    async pin(hostId, publicKey) {
      const current = await loaded();
      const incumbent = current[hostId];
      if (incumbent !== undefined) return incumbent;
      // Mutated BEFORE the write and rolled back after a failed one, rather than snapshotted: the map is shared by every in-flight pin, and a snapshot taken here would drop a concurrent.
      current[hostId] = publicKey;
      try {
        // `saveStrict`, not `save`: `save` swallows a persist failure, so a read-only userData or an ENOSPC would log a pin nothing wrote and never reach `onPinWriteFailed`.
        await file.saveStrict({ pins: current });
      } catch (cause) {
        // Undo the memory half too, or the failed pin reads as pinned for the
        // rest of the process and blocks the retry the next registry read
        // would perform - while disappearing at the next restart.
        delete current[hostId];
        throw cause;
      }
      log.info("[host-key-pin] pinned a host's static key on first sight", {
        hostId,
      });
      return publicKey;
    },
    describeLocation() {
      return filePath;
    },
  };

  installHostKeyPinStore({
    store,
    onPinWriteFailed: (hostId: string, cause: unknown) => {
      // The host is admitted anyway - nothing is pinned, so nothing disagrees - and the next registry read tries the write again.
      log.warn("[host-key-pin] could not write a first-sight pin", {
        hostId,
        error: describeLogError(cause),
      });
    },
    onMismatch: (error: HostKeyPinMismatchError) => {
      // The log is the record; the fan-out is the surfacing. There is no
      // un-pin affordance to point at, so both carry the file path and the two
      // keys - see `HostKeyPinMismatchError`.
      log.error("[host-key-pin] refusing a host whose static key changed", {
        hostId: error.hostId,
        pinnedKey: error.pinnedKey,
        offeredKey: error.offeredKey,
        message: error.message,
      });
      mismatchEmitter?.({
        hostId: error.hostId,
        pinnedKey: error.pinnedKey,
        offeredKey: error.offeredKey,
        pinLocation: filePath,
        remedy: error.message,
        observedAt: Date.now(),
      });
    },
  });
}
