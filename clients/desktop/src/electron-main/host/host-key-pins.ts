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

/**
 * The durable half of the host Noise-static-key TOFU pin
 * (browser-security-hardening H11); the rule itself lives in
 * `@traycer-clients/shared/host-client/host-key-pin`.
 *
 * A plain `{hostId: publicKey}` file beside the other desktop stores, and
 * deliberately nothing more: a public key is not a secret, so this file is
 * integrity-relevant only - which is exactly why the recovery is "delete the
 * line" rather than a UI. Installing it here also covers the renderer, whose
 * host list is this process's `fetchRegisteredHostsViaHttp` answer relayed
 * over IPC.
 */

const STORE_FILE_NAME = "host-key-pins.json";

/**
 * Where a refusal goes so a surface can say it happened, exactly as
 * `setPendingCertificateEmitter` carries the app shell's certificate
 * refusals: this store is installed in the on-ready phase, before the runner
 * host bridge exists, so startup hands the fan-out down afterwards. A refusal
 * before that (or in a shell with no bridge) is logged and nothing more -
 * the host is refused either way, which is the part that must not depend on
 * anyone listening.
 */
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
  // Memoised on the PROMISE, not on its result: two registry reads can be in
  // flight at once (the renderer's directory poll and main's own jar-stream
  // resolve), and memoising the settled value let both start a load, both see
  // an empty map, and the second's write clobber the first's first-sight pin.
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
      // Mutated BEFORE the write and rolled back after a failed one, rather
      // than snapshotted: the map is shared by every in-flight pin, and a
      // snapshot taken here would drop a concurrent first-sight pin that
      // landed in the map after it (R3-9).
      current[hostId] = publicKey;
      try {
        // `saveStrict`, not `save`: `save` swallows a persist failure, so a
        // read-only userData or an ENOSPC would log a pin nothing wrote and
        // never reach `onPinWriteFailed`. A first-sight pin is the whole of
        // this store's TOFU protection - a write that did not land has to be
        // reported.
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
    },
    describeLocation() {
      return filePath;
    },
  };

  installHostKeyPinStore({
    store,
    onPinWriteFailed: (hostId: string, cause: unknown) => {
      // The host is admitted anyway - nothing is pinned, so nothing disagrees -
      // and the next registry read tries the write again. What it costs until
      // then is TOFU protection for this host, which is why it is a warning
      // rather than a debug line.
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
