import type { SchemaVersion } from "@traycer/protocol/framework/index";
import {
  epicCreateV10,
  epicListTasksV10,
  epicListTasksV11,
  epicListTasksV12,
} from "@traycer/protocol/host/epic/contracts";
import {
  hostStatusV10,
  hostStatusV11,
} from "@traycer/protocol/host/status/contracts";
import { z } from "zod";
import type { EpicCatalog } from "./catalog";

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
  catalog: EpicCatalog,
): RpcDispatchResult {
  try {
    return dispatchImplementedMethod(method, schemaVersion, params, catalog);
  } catch (cause) {
    const invalid = cause instanceof z.ZodError;
    return {
      result: null,
      error: {
        code: invalid ? "E_INVALID_ARGUMENT" : "RPC_ERROR",
        message: errorMessage(cause),
      },
    };
  }
}

function dispatchImplementedMethod(
  method: string,
  schemaVersion: SchemaVersion,
  params: unknown,
  catalog: EpicCatalog,
): RpcDispatchResult {
  if (method === "host.status") {
    return {
      result: handleHostStatus(schemaVersion, params),
      error: null,
    };
  }
  if (method === "epic.listTasks") {
    return handleEpicListTasks(schemaVersion, params, catalog);
  }
  if (method === "epic.create") {
    return handleEpicCreate(schemaVersion, params, catalog);
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
  catalog: EpicCatalog,
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
    result: contract.responseSchema.parse({
      tasks: catalog.list(),
      hasMore: false,
    }),
    error: null,
  };
}

function handleEpicCreate(
  schemaVersion: SchemaVersion,
  params: unknown,
  catalog: EpicCatalog,
): RpcDispatchResult {
  if (schemaVersion.major !== 1 || schemaVersion.minor !== 0) {
    return {
      result: null,
      error: { code: "E_HOST_UNSUPPORTED", message: "epic.create" },
    };
  }
  const request = epicCreateV10.requestSchema.parse(params);
  const task = catalog.insert(request.epic);
  return {
    result: epicCreateV10.responseSchema.parse({
      roomInfo: null,
      task,
      initialTurnStarted: false,
    }),
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
