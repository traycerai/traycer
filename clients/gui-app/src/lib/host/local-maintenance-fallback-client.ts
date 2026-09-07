import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRequestControlFlowError } from "@traycer-clients/shared/host-client/host-request-coordinator";
import { getNegotiatedHostMethods } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  HostRpcError,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  IHostManagement,
  InstallVersionOk,
  MaintenanceDoctorProjection,
  MutationOutcome,
} from "@traycer-clients/shared/platform/runner-host";
import {
  type HostDoctorResponse,
  type HostGetInstallationInfoResponse,
  type HostUpdateCheckRequestV11,
  type HostUpdateCheckResponseV11,
  type HostUpdateInstallRequest,
  type HostUpdateInstallResponseV11,
} from "@traycer/protocol/host/maintenance/index";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { appLogger } from "@/lib/logger";

/**
 * Serve v1.2.0 maintenance RPCs over desktop IPC only when handshake is definitively `false`.
 * Delete when the fleet floor reaches host v1.2.0.
 */

/** The pinned intercepted set. Adding a method here is a deliberate act. */
export const LOCAL_MAINTENANCE_FALLBACK_METHODS = [
  "host.update.check",
  "host.update.install",
  "host.doctor",
  "host.getInstallationInfo",
] as const;

export type LocalMaintenanceFallbackMethod =
  (typeof LOCAL_MAINTENANCE_FALLBACK_METHODS)[number];

const FALLBACK_METHOD_SET: ReadonlySet<string> = new Set(
  LOCAL_MAINTENANCE_FALLBACK_METHODS,
);

function isFallbackMethod(
  method: string,
): method is LocalMaintenanceFallbackMethod {
  return FALLBACK_METHOD_SET.has(method);
}

/**
 * IPC `installVersion` resolves at completion; RPC `accepted` means the CLI took the job.
 * Post-commit `busy` throws so the page stays live for the restart it names.
 */
export function mapInstallVersionOutcome(
  outcome: MutationOutcome<InstallVersionOk>,
): HostUpdateInstallResponseV11 {
  switch (outcome.kind) {
    case "ok":
      // Permanent `attemptId: null`: this lane predates attempt records. Do not fill it at a cutover; delete the module instead.
      return { outcome: "accepted", attemptId: null };
    case "busy":
    case "deferred":
      throw new HostRpcError({
        code: "RPC_ERROR",
        message: outcome.message,
        requestId: "local-maintenance-fallback",
        method: "host.update.install",
        fatalDetails: null,
      });
    case "failed":
    case "stage-fingerprint-mismatch":
    case "installed-not-converged":
      appLogger.warn("[local-maintenance-fallback] install did not complete", {
        kind: outcome.kind,
        message: outcome.message,
      });
      return { outcome: "cli-failed" };
  }
}

/**
 * Empty trivially-green set: an IPC doctor reply does not prove the host listener is live.
 */
export function localWsDoctorResponse(
  projection: MaintenanceDoctorProjection,
): HostDoctorResponse {
  if (projection.status !== "ok") {
    return { status: projection.status };
  }
  return {
    status: "ok",
    issues: [...projection.issues],
    triviallyGreenIssueCodes: [],
  };
}

/**
 * The four mappings, each fully typed against its protocol pair.
 * Exported for the mapper unit tests; the decorator below is the only production caller.
 */
export interface MaintenanceFallbackServeMap {
  readonly "host.update.check": (
    params: HostUpdateCheckRequestV11,
  ) => Promise<HostUpdateCheckResponseV11>;
  readonly "host.update.install": (
    params: HostUpdateInstallRequest,
  ) => Promise<HostUpdateInstallResponseV11>;
  readonly "host.doctor": () => Promise<HostDoctorResponse>;
  readonly "host.getInstallationInfo": () => Promise<HostGetInstallationInfoResponse>;
}

export function buildMaintenanceFallbackServeMap(
  management: IHostManagement,
  /** The host this map was built for, sent with every call. */
  expectedHostId: string,
): MaintenanceFallbackServeMap {
  return {
    "host.update.check": (params) =>
      management.maintenanceUpdateCheck({
        includePreReleases: params.includePreReleases,
        expectedHostId,
      }),
    "host.update.install": async (params) => {
      // The RPC resolver refuses a second install while its own update claim is live (`already-updating`), because the CLI's lock covers only the brief precheck and promote phases - two runs download in parallel and can swap twice.
      const dispatch = await management.maintenanceInstallVersion({
        version: params.version,
        force: params.force,
        expectedHostId,
      });
      if (dispatch.kind === "lane-busy") {
        // `already-updating` is reserved for lane work that IS an update.
        // Claiming it for a service registration or a free-port repair does more than mislabel: `handleInstallOutcome` arms the accepted-update latch on it and then waits up to a minute for `host.status.updateProgress` - a field these hosts never publish, and which.
        if (dispatch.updateInFlight) {
          // Same `null` as the `accepted` arm above, for the same reason and with the same permanence: the lane is busy with an update this client cannot name, and never will be able to.
          // See that arm's note before touching this at the ticket-07 cutover.
          return { outcome: "already-updating", attemptId: null };
        }
        // Transient contention, reported the same way this map already reports the controller's own `busy` and `deferred`: a refusal the caller renders and the person can simply retry.
        throw new HostRpcError({
          code: "RPC_ERROR",
          message: dispatch.message,
          requestId: "local-maintenance-fallback",
          method: "host.update.install",
          fatalDetails: null,
        });
      }
      return mapInstallVersionOutcome(dispatch.outcome);
    },
    "host.doctor": async () =>
      localWsDoctorResponse(
        await management.maintenanceDoctor({ expectedHostId }),
      ),
    "host.getInstallationInfo": () =>
      management.maintenanceInstallationInfo({ expectedHostId }),
  };
}

/**
 * Dispatch one served call.
 * A runtime `switch` cannot narrow the caller's generic `Method` back to its concrete request/response pair, so each arm re-associates the pair the switch just proved - the same seam `ws-rpc-client.ts` re-associates its parsed response at.
 */
function serveFallbackRequest<Method extends keyof HostRpcRegistry & string>(
  serve: MaintenanceFallbackServeMap,
  method: LocalMaintenanceFallbackMethod,
  params: RequestOfMethod<HostRpcRegistry, Method>,
): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
  const request: unknown = params;
  const answer = ((): Promise<
    | HostUpdateCheckResponseV11
    | HostUpdateInstallResponseV11
    | HostDoctorResponse
    | HostGetInstallationInfoResponse
  > => {
    switch (method) {
      case "host.update.check":
        return serve[method](request as HostUpdateCheckRequestV11);
      case "host.update.install":
        return serve[method](request as HostUpdateInstallRequest);
      case "host.doctor":
        return serve[method]();
      case "host.getInstallationInfo":
        return serve[method]();
    }
  })();
  return answer as Promise<ResponseOfMethod<HostRpcRegistry, Method>>;
}

/** Wrap the resolved scope client for THIS MACHINE'S local host. */
export function createLocalMaintenanceFallbackClient(input: {
  readonly client: HostClient<HostRpcRegistry>;
  /** The local host this decorator was constructed for - never re-derived. */
  readonly localHostId: string;
  readonly management: IHostManagement;
}): HostClient<HostRpcRegistry> {
  const { client, localHostId, management } = input;
  const serve = buildMaintenanceFallbackServeMap(management, localHostId);

  const shouldServe = (
    method: string,
  ): method is LocalMaintenanceFallbackMethod => {
    if (!isFallbackMethod(method)) return false;
    // The wrapped client must still address the host this decorator was constructed for.
    // `use-host-scope` rebuilds the decorator when the scope moves, so a mismatch here is a transient (an unresolved row reports `null`) - delegating is the safe answer in every such state.
    if (client.getActiveHostId() !== localHostId) return false;
    // Live handshake answer, read per call: `null` (no handshake yet) and `true` both delegate - only a definitive `false` routes to the IPC lane.
    // A host upgraded in place re-handshakes, the registry flips, and this same read makes every later call delegate with no rebuild.
    const negotiated = getNegotiatedHostMethods(localHostId);
    if (negotiated === null) return false;
    return !negotiated.has(method);
  };

  /**
   * Re-serve only if this call's own handshake first revealed the method absent.
   */
  const delegateThenServeIfAbsent = async <
    Method extends keyof HostRpcRegistry & string,
  >(
    method: Method,
    params: RequestOfMethod<HostRpcRegistry, Method>,
    signal: AbortSignal | undefined,
    delegate: () => Promise<ResponseOfMethod<HostRpcRegistry, Method>>,
  ): Promise<ResponseOfMethod<HostRpcRegistry, Method>> => {
    try {
      return await delegate();
    } catch (error) {
      // A cancelled call is not a refusal - the caller stopped wanting the answer, so re-issuing it over the bridge would resurrect work the query layer just abandoned.
      if (signal?.aborted === true) throw error;
      if (!shouldServe(method)) throw error;
      return serveRespectingSignal<Method>(method, params, signal);
    }
  };

  /** Serve over the IPC lane while honoring the caller's cancellation. */
  const serveRespectingSignal = <Method extends keyof HostRpcRegistry & string>(
    method: LocalMaintenanceFallbackMethod,
    params: RequestOfMethod<HostRpcRegistry, Method>,
    signal: AbortSignal | undefined,
  ): Promise<ResponseOfMethod<HostRpcRegistry, Method>> => {
    if (signal === undefined) {
      return serveFallbackRequest<Method>(serve, method, params);
    }
    if (signal.aborted) {
      return Promise.reject(
        new HostRequestControlFlowError("waiter-cancelled"),
      );
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        reject(new HostRequestControlFlowError("waiter-cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      serveFallbackRequest<Method>(serve, method, params).then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          // The serve map rejects with the IPC taxonomy's `Error`s; the
          // instanceof guard is for the rejection contract, not a real arm.
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  };

  return new Proxy(client, {
    get: (target, property, receiver) => {
      if (property === "request") {
        return <Method extends keyof HostRpcRegistry & string>(
          method: Method,
          params: RequestOfMethod<HostRpcRegistry, Method>,
        ) =>
          shouldServe(method)
            ? serveFallbackRequest<Method>(serve, method, params)
            : delegateThenServeIfAbsent(method, params, undefined, () =>
                target.request(method, params),
              );
      }
      if (property === "requestWithSignal") {
        return <Method extends keyof HostRpcRegistry & string>(
          method: Method,
          params: RequestOfMethod<HostRpcRegistry, Method>,
          signal: AbortSignal | undefined,
        ) =>
          shouldServe(method)
            ? serveRespectingSignal<Method>(method, params, signal)
            : delegateThenServeIfAbsent(method, params, signal, () =>
                target.requestWithSignal(method, params, signal),
              );
      }
      if (property === "requestWithResponseTimeout") {
        // None of the intercepted four is a long-poll method today; this is intercepted anyway so a future hook migration cannot silently route an intercepted method back onto a transport the handshake refused.
        return <Method extends keyof HostRpcRegistry & string>(
          method: Method,
          params: RequestOfMethod<HostRpcRegistry, Method>,
          responseTimeoutMs: number,
        ) =>
          shouldServe(method)
            ? serveFallbackRequest<Method>(serve, method, params)
            : delegateThenServeIfAbsent(method, params, undefined, () =>
                target.requestWithResponseTimeout(
                  method,
                  params,
                  responseTimeoutMs,
                ),
              );
      }
      // Same fall-through discipline as `createPinnedRequester`: everything else binds to the wrapped client, which owns identity, context and subscriptions.
      // (`bind` on an already-bound member is a no-op, so a wrapped pinned requester keeps its own interceptions intact.)
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const bound: unknown = value.bind(target);
      return bound;
    },
  });
}
