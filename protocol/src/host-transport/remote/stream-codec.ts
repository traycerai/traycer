import type {
  SchemaVersion,
  StreamMethodVersionRegistry,
  VersionedStreamRpcRegistry,
} from "../../framework/versioned-stream-rpc";

export type ParamsOf<
  Registry extends VersionedStreamRpcRegistry,
  Method extends keyof Registry & string,
> = ExtractOpenRequest<Registry[Method]>;

type ExtractOpenRequest<MethodRegistry> =
  MethodRegistry extends Readonly<Record<number, infer Line>>
    ? Line extends {
        readonly versions: Readonly<Record<number, infer Entry>>;
      }
      ? Entry extends {
          readonly contract: {
            readonly openRequestSchema: infer OpenSchema;
          };
        }
        ? OpenSchema extends { readonly _output: infer Output }
          ? Output
          : unknown
        : unknown
      : unknown
    : unknown;

/**
 * What `subscribeWithParamsProvider` re-reads before every wire subscribe.
 *
 * The argument is the version the params are about to be DECLARED at, so a
 * method served on more than one major can shape its open request for the
 * major that was actually negotiated - which is knowable only here, after the
 * open-ack selection and before the subscribe frame is written. A provider
 * that serves one line ignores it, so widening this cost existing providers
 * nothing.
 *
 * `null` means the transport cannot report a version: it is the runtime
 * worker's stream proxy, which invokes the provider on the WORKER side and
 * pushes the value across, where the negotiation is main's to observe. A
 * provider that gets `null` must answer with what it would send before any
 * handshake - its newest line - and never guess an older one; the proxy
 * carries only single-major epic methods, so no multi-major consumer is
 * reached through it.
 */
export type StreamParamsProvider<
  Registry extends VersionedStreamRpcRegistry,
  Method extends keyof Registry & string,
> = (onWireVersion: SchemaVersion | null) => ParamsOf<Registry, Method>;

/**
 * Which version {@link prepareStreamSubscribeRequest} will declare, decided
 * from the two manifests alone - so a caller can know it BEFORE it has the
 * params, which is what lets a params provider shape its open request for the
 * major that was actually negotiated (see {@link StreamParamsProvider}).
 *
 * Extracted rather than duplicated at the call sites precisely because those
 * two answers must never diverge: a provider told `@1` whose payload is then
 * declared as `@2` writes a frame the peer's strict schema drops, silently and
 * on the open. Both transports read it through this function and then hand the
 * same pair to `prepareStreamSubscribeRequest`.
 */
export function selectStreamSubscribeVersion(
  myCanonical: SchemaVersion,
  theirCanonical: SchemaVersion,
): SchemaVersion {
  if (
    myCanonical.major !== theirCanonical.major ||
    myCanonical.minor <= theirCanonical.minor
  ) {
    return myCanonical;
  }
  return theirCanonical;
}

export interface PreparedStreamSubscribeRequest {
  readonly onWireVersion: SchemaVersion;
  readonly onWirePayload: unknown;
}

export function prepareStreamSubscribeRequest(
  registry: VersionedStreamRpcRegistry,
  method: string,
  myCanonical: SchemaVersion,
  theirCanonical: SchemaVersion,
  params: unknown,
): PreparedStreamSubscribeRequest {
  if (
    myCanonical.major !== theirCanonical.major ||
    myCanonical.minor <= theirCanonical.minor
  ) {
    return { onWireVersion: myCanonical, onWirePayload: params };
  }
  const methodRegistry = registry[method] as StreamMethodVersionRegistry;
  const olderLine = methodRegistry[myCanonical.major];
  const olderEntry = olderLine.versions[theirCanonical.minor];
  return {
    onWireVersion: theirCanonical,
    onWirePayload: olderEntry.contract.openRequestSchema.parse(params),
  };
}
