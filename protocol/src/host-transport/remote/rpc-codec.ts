import {
  downgradeRequestAcrossMajors,
  upgradeResponseToVersion,
  type MethodVersionRegistry,
  type SchemaVersion,
} from "../../framework/index";
import { HostRpcError } from "./rpc-types";

export interface PreparedRequest<Payload> {
  readonly onWireVersion: SchemaVersion;
  readonly onWirePayload: Payload;
}

export function prepareRequestPayload<Payload>(
  methodRegistry: MethodVersionRegistry,
  clientCanonical: SchemaVersion,
  hostCanonical: SchemaVersion,
  params: Payload,
  requestId: string,
  method: string,
): PreparedRequest<Payload> {
  if (clientCanonical.major === hostCanonical.major) {
    if (clientCanonical.minor <= hostCanonical.minor) {
      return { onWireVersion: clientCanonical, onWirePayload: params };
    }
    const olderLine = methodRegistry[hostCanonical.major];
    const olderEntry = olderLine.versions[hostCanonical.minor];
    if (olderEntry === undefined) {
      throw new HostRpcError({
        code: "RPC_ERROR",
        message: `No installed contract for method '${method}' ${hostCanonical.major}.${hostCanonical.minor}`,
        requestId,
        method,
        fatalDetails: null,
      });
    }
    const strippedParse = olderEntry.contract.requestSchema.safeParse(params);
    if (!strippedParse.success) {
      throw new HostRpcError({
        code: "DOWNGRADE_UNSUPPORTED",
        message: `Failed to project request params onto ${hostCanonical.major}.${hostCanonical.minor}: ${strippedParse.error.message}`,
        requestId,
        method,
        fatalDetails: null,
      });
    }
    return {
      onWireVersion: hostCanonical,
      onWirePayload: strippedParse.data as Payload,
    };
  }
  if (clientCanonical.major < hostCanonical.major) {
    return { onWireVersion: clientCanonical, onWirePayload: params };
  }
  const downgraded = downgradeRequestAcrossMajors(
    methodRegistry,
    clientCanonical.major,
    hostCanonical.major,
    params as never,
  );
  if (!downgraded.ok) {
    throw new HostRpcError({
      code: "DOWNGRADE_UNSUPPORTED",
      message: downgraded.error.message,
      requestId,
      method,
      fatalDetails: null,
    });
  }
  return {
    onWireVersion: hostCanonical,
    onWirePayload: downgraded.value as Payload,
  };
}

export function decodeResponsePayload<Payload>(
  methodRegistry: MethodVersionRegistry,
  clientCanonical: SchemaVersion,
  hostCanonical: SchemaVersion,
  result: unknown,
  requestId: string,
  method: string,
): Payload {
  if (clientCanonical.major === hostCanonical.major) {
    if (clientCanonical.minor <= hostCanonical.minor) return result as Payload;
    return upgradeResponseAlongChain(
      methodRegistry,
      hostCanonical,
      clientCanonical,
      result,
      requestId,
      method,
    );
  }
  if (clientCanonical.major < hostCanonical.major) return result as Payload;
  return upgradeResponseAlongChain(
    methodRegistry,
    hostCanonical,
    clientCanonical,
    result,
    requestId,
    method,
  );
}

function upgradeResponseAlongChain<Payload>(
  methodRegistry: MethodVersionRegistry,
  fromVersion: SchemaVersion,
  toVersion: SchemaVersion,
  result: unknown,
  requestId: string,
  method: string,
): Payload {
  try {
    const fromEntry =
      methodRegistry[fromVersion.major]?.versions[fromVersion.minor];
    let chainInput = result;
    if (fromEntry !== undefined) {
      const parsed = fromEntry.contract.responseSchema.safeParse(result);
      if (!parsed.success) {
        throw new Error(
          `response does not match the ${fromVersion.major}.${fromVersion.minor} response schema`,
        );
      }
      chainInput = parsed.data;
    }
    return upgradeResponseToVersion(
      methodRegistry,
      fromVersion,
      toVersion,
      chainInput as never,
    ) as Payload;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new HostRpcError({
      code: "RPC_ERROR",
      message: `Failed to upgrade response from ${fromVersion.major}.${fromVersion.minor} to ${toVersion.major}.${toVersion.minor}: ${message}`,
      requestId,
      method,
      fatalDetails: null,
    });
  }
}
