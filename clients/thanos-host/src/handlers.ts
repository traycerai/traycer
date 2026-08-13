import type { SchemaVersion } from "@traycer/protocol/framework/index";
import {
  epicListTasksV10,
  epicListTasksV11,
  epicListTasksV12,
} from "@traycer/protocol/host/epic/contracts";
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
const EMPTY_LIST_TASKS = { tasks: [], hasMore: false } as const;

export function dispatchRpc(
  method: string,
  schemaVersion: SchemaVersion,
  params: unknown,
): RpcDispatchResult {
  try {
    return dispatchImplementedMethod(method, schemaVersion, params);
  } catch (cause) {
    return {
      result: null,
      error: {
        code: "E_INVALID_ARGUMENT",
        message: errorMessage(cause),
      },
    };
  }
}

function dispatchImplementedMethod(
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
  if (method === "epic.listTasks") {
    return handleEpicListTasks(schemaVersion, params);
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

function handleEpicListTasks(
  schemaVersion: SchemaVersion,
  params: unknown,
): RpcDispatchResult {
  const contract = epicListTasksContract(schemaVersion);
  if (contract === null) {
    return {
      result: null,
      error: { code: "E_HOST_UNSUPPORTED", message: "epic.listTasks" },
    };
  }
  contract.requestSchema.parse(params);
  return {
    result: contract.responseSchema.parse(EMPTY_LIST_TASKS),
    error: null,
  };
}

function epicListTasksContract(
  schemaVersion: SchemaVersion,
):
  | typeof epicListTasksV10
  | typeof epicListTasksV11
  | typeof epicListTasksV12
  | null {
  if (schemaVersion.major !== 1) {
    return null;
  }
  if (schemaVersion.minor === 0) {
    return epicListTasksV10;
  }
  if (schemaVersion.minor === 1) {
    return epicListTasksV11;
  }
  if (schemaVersion.minor === 2) {
    return epicListTasksV12;
  }
  return null;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return "invalid request";
}
