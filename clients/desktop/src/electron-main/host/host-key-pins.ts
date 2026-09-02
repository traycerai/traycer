import { app } from "electron";
import { join } from "node:path";
import { z } from "zod";
import { log } from "../app/logger";
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
  let pins: Record<string, string> | null = null;

  const loaded = async (): Promise<Record<string, string>> => {
    if (pins === null) {
      pins = { ...(await file.load()).pins };
    }
    return pins;
  };

  const store: HostKeyPinStore = {
    async read(hostId) {
      return (await loaded())[hostId] ?? null;
    },
    async pin(hostId, publicKey) {
      const current = await loaded();
      current[hostId] = publicKey;
      await file.save({ pins: current });
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
