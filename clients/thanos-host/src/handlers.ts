import type { SchemaVersion } from "@traycer/protocol/framework/index";
import {
  hostStatusV10,
  hostStatusV11,
} from "@traycer/protocol/host/status/contracts";

export type RpcDispatchError = {
  readonly code: string;
  readonly message: string;
};

export type RpcDispatchResult = {
  readonly result: unknown | null;
  readonly error: RpcDispatchError | null;
};

const HOST_VERSION = "0.0.0-thanos";
const PROTOCOL_VERSION = { major: 1, minor: 1 } as const;

export function dispatchRpc(
  method: string,
  schemaVersion: SchemaVersion,
  params: unknown,
): RpcDispatchResult {
  if (method === "host.status") {
    return {
      result: handleHostStatus(schemaVersion, params),
      error: null,
    };
  }
  return {
    result: null,
    error: { code: "E_HOST_UNSUPPORTED", message: method },
  };
}

function handleHostStatus(
  schemaVersion: SchemaVersion,
  params: unknown,
): unknown {
  if (schemaVersion.major === 1 && schemaVersion.minor === 0) {
    hostStatusV10.requestSchema.parse(params);
    return hostStatusV10.responseSchema.parse({
      ready: true,
      hostVersion: HOST_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    });
  }
  hostStatusV11.requestSchema.parse(params);
  return hostStatusV11.responseSchema.parse({
    ready: true,
    hostVersion: HOST_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    busy: false,
    busySessionCount: 0,
    updateProgress: null,
  });
}
