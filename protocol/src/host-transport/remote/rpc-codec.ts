import {
  downgradeRequestAcrossMajors,
  upgradeResponseToVersion,
  upgradeResponseToVersionWithContext,
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
  return decodeResponsePayloadWithContext(
    methodRegistry,
    clientCanonical,
    hostCanonical,
    result,
    requestId,
    method,
    null,
    "",
  );
}

export function decodeResponsePayloadWithContext<Payload>(
  methodRegistry: MethodVersionRegistry,
  clientCanonical: SchemaVersion,
  hostCanonical: SchemaVersion,
  result: unknown,
  requestId: string,
  method: string,
  onWireRequest: unknown,
  hostId: string,
): Payload {
  const context =
    hostId.length === 0 ? null : { request: onWireRequest, hostId };
  if (clientCanonical.major === hostCanonical.major) {
    if (clientCanonical.minor <= hostCanonical.minor) return result as Payload;
    return upgradeResponseAlongChain(
      methodRegistry,
      hostCanonical,
      clientCanonical,
      result,
      requestId,
      method,
      context,
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
    context,
  );
}

function upgradeResponseAlongChain<Payload>(
  methodRegistry: MethodVersionRegistry,
  fromVersion: SchemaVersion,
  toVersion: SchemaVersion,
  result: unknown,
  requestId: string,
  method: string,
  context: { readonly request: unknown; readonly hostId: string } | null,
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
    const upgraded =
      context === null
        ? upgradeResponseToVersion(
            methodRegistry,
            fromVersion,
            toVersion,
            chainInput as never,
          )
        : upgradeResponseToVersionWithContext(
            methodRegistry,
            fromVersion,
            toVersion,
            chainInput as never,
            { request: context.request as never, hostId: context.hostId },
          );
    return upgraded as Payload;
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
