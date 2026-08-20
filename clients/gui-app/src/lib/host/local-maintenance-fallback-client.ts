import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
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
  LOCAL_WS_DOCTOR_TRIVIALLY_GREEN_ISSUE_CODES,
  type HostDoctorResponse,
  type HostGetInstallationInfoResponse,
  type HostUpdateCheckRequest,
  type HostUpdateCheckResponse,
  type HostUpdateInstallRequest,
  type HostUpdateInstallResponse,
} from "@traycer/protocol/host/maintenance/index";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { appLogger } from "@/lib/logger";

/**
 * A decorator over the LOCAL host's real `HostClient` that answers the
 * v1.2.0 maintenance RPCs over the desktop IPC → bundled CLI lane when — and
 * only when — the host's handshake definitively refused them.
 *
 * Why it exists: the maintenance family (`host.update.check/install`,
 * `host.doctor`, `host.getInstallationInfo`) ships in host v1.2.0, so against
 * a released local host (≤ 1.1.11) every Overview control degrades to an
 * "update it and this comes back" notice — during exactly the window where
 * the page is the lever for performing that update. Remote hosts first ship
 * AT v1.2.0, so only a local host can be in this state, and the trigger
 * population is frozen: every fallback-lane update, desktop launch converge,
 * and menu update moves a host permanently out of it.
 *
 * ⏳ SUNSET: delete this module (and the `maintenance*` members it consumes on
 * `IHostManagement`) when the supported fleet floor reaches the
 * maintenance-RPC host version (v1.2.0).
 *
 * Both lanes are projections of the same computation — the host's own
 * maintenance resolvers shell the same `traycer host …` CLI and read the same
 * on-disk records the desktop bridge does — so this maps between two
 * projections of identical data, never inventing an answer the host could
 * not have given.
 *
 * The contract, in order of importance:
 *
 *  1. CAPABILITY HONESTY. The decorator never answers method-support
 *     questions; the negotiated-manifest registry keeps reporting the truth.
 *     A call is served here only on a definitive handshake `false` — on
 *     `true` or `null` (no handshake yet) it delegates, so the fallback never
 *     triggers on ignorance, and a call in flight while support is unknown
 *     resolves the handshake exactly as today.
 *  2. PINNED SET. Exactly the four methods below. Restart is deliberately
 *     handled outside (the Overview's explicit force offer); the service
 *     verbs and rename are deliberately degraded (no honest IPC source /
 *     identity split-brain) — see the Overview's capability wiring.
 *  3. SELF-RETIRING. A fallback-lane update bounces the host into ≥ v1.2.0;
 *     the availability-recovered invalidation refetches, the reconnect
 *     handshake flips the registry, and every call from then on delegates.
 *     Query keys are host+method and identical across lanes, so the flip
 *     needs no cache surgery.
 *
 * Scheduling note: served calls bypass `HostRequestCoordinator` — they never
 * touch the host transport. That is accepted (the lane exists precisely
 * because the host cannot answer these), so nobody should hunt here for
 * missing latest/join coalescing.
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
 * `host.update.install`'s outcome mapping between the two lanes' resolution
 * semantics. The RPC's `accepted` means "the detached CLI took the job";
 * IPC `installVersion` resolves its `MutationOutcome` at COMPLETION. The
 * mapping embraces that instead of hiding it:
 *
 *  - `ok` (completed) → `accepted`. The Overview's accepted-latch stays armed
 *    from dispatch through resolution — the genuine swap window — and its
 *    brief post-completion tail overlaps the host's own restart, when
 *    lifecycle controls SHOULD be locked; the latch's bounded timer and the
 *    reconnect close it.
 *  - `busy` / `deferred` → a typed mutation error carrying the lane's own
 *    message. Both are self-clearing "retry when idle" conditions; the error
 *    channel releases the accepted latch (nothing was dispatched) and the
 *    page's existing failure toast renders the message. The busy
 *    continuation affordance is deliberately NOT carried on this lane.
 *  - `failed` / `stage-fingerprint-mismatch` / `installed-not-converged` →
 *    `cli-failed`, the host's own taxonomy for "the CLI tried and couldn't".
 *    The wire arm carries no message, so the lane's message goes to the log.
 */
export function mapInstallVersionOutcome(
  outcome: MutationOutcome<InstallVersionOk>,
): HostUpdateInstallResponse {
  switch (outcome.kind) {
    case "ok":
      return { outcome: "accepted" };
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
 * Stamp the doctor projection with the LOCAL-WS trivially-green set.
 *
 * The vantage is the caller's judgment, not the bridge's: this fallback only
 * ever serves this machine's local host over its direct loopback connection,
 * which is precisely the vantage the protocol's local-WS set describes — a
 * `SERVICE_STOPPED` in a report obtained while that host is answering us
 * describes a service that is demonstrably running. The desktop main process
 * cannot see the transport, which is why the projection arrives without the
 * field rather than with a guessed one.
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
    triviallyGreenIssueCodes: [...LOCAL_WS_DOCTOR_TRIVIALLY_GREEN_ISSUE_CODES],
  };
}

/**
 * The four mappings, each fully typed against its protocol pair. Exported for
 * the mapper unit tests; the decorator below is the only production caller.
 *
 * `host.update.check` and `host.getInstallationInfo` are identities: the
 * desktop main process already resolves the protocol response shape (it owns
 * failure classification, because an Electron invoke rejection loses its
 * error shape at the context-bridge boundary). An IPC rejection — the bridge
 * handler itself threw — propagates and is normalized to a plain
 * `HostRpcError` by the query/mutation boundary, so refusal semantics fire
 * rather than the transport-failure "probable dispatch" semantics.
 */
export interface MaintenanceFallbackServeMap {
  readonly "host.update.check": (
    params: HostUpdateCheckRequest,
  ) => Promise<HostUpdateCheckResponse>;
  readonly "host.update.install": (
    params: HostUpdateInstallRequest,
  ) => Promise<HostUpdateInstallResponse>;
  readonly "host.doctor": () => Promise<HostDoctorResponse>;
  readonly "host.getInstallationInfo": () => Promise<HostGetInstallationInfoResponse>;
}

export function buildMaintenanceFallbackServeMap(
  management: IHostManagement,
): MaintenanceFallbackServeMap {
  return {
    "host.update.check": (params) =>
      management.maintenanceUpdateCheck({
        includePreReleases: params.includePreReleases,
      }),
    "host.update.install": async (params) =>
      mapInstallVersionOutcome(
        await management.installVersion(params.version, params.force),
      ),
    "host.doctor": async () =>
      localWsDoctorResponse(await management.maintenanceDoctor()),
    "host.getInstallationInfo": () => management.maintenanceInstallationInfo(),
  };
}

/**
 * Dispatch one served call. A runtime `switch` cannot narrow the caller's
 * generic `Method` back to its concrete request/response pair, so each arm
 * re-associates the pair the switch just proved — the same seam
 * `ws-rpc-client.ts` re-associates its parsed response at. The serve map
 * itself is fully typed per method, so a wrong pairing here fails the arm's
 * own call.
 */
function serveFallbackRequest<Method extends keyof HostRpcRegistry & string>(
  serve: MaintenanceFallbackServeMap,
  method: LocalMaintenanceFallbackMethod,
  params: RequestOfMethod<HostRpcRegistry, Method>,
): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
  const request: unknown = params;
  const answer = ((): Promise<
    | HostUpdateCheckResponse
    | HostUpdateInstallResponse
    | HostDoctorResponse
    | HostGetInstallationInfoResponse
  > => {
    switch (method) {
      case "host.update.check":
        return serve[method](request as HostUpdateCheckRequest);
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

/**
 * Wrap the resolved scope client for THIS MACHINE'S local host.
 *
 * Construction is owned by `use-host-scope.ts`, at the point where
 * `scope.client` is decided, and gated there on the two facts that make the
 * lane real: the scoped host is this machine's local host, and the shell has
 * a `hostManagement` bridge. Every Overview consumer receives the decorated
 * client through the path it already uses (`scope.client`); nothing else
 * needs to know the lane exists.
 *
 * ⚠ `createRequester` / `createRequesterForHostId` deliberately fall through
 * UNDECORATED: a requester minted off this client is a new routing view whose
 * host may not be the local one, and re-decorating it here would re-create
 * the "which host is this about" ambiguity the scope model exists to prevent.
 * Consumers that resolve their own requester (the app-wide resolution in
 * `binding-host-client.ts`) therefore bypass the fallback — which is why the
 * Overview reads `scope.client` and why the fence tests pin that read,
 * including the `following` state.
 */
export function createLocalMaintenanceFallbackClient(input: {
  readonly client: HostClient<HostRpcRegistry>;
  /** The local host this decorator was constructed for — never re-derived. */
  readonly localHostId: string;
  readonly management: IHostManagement;
}): HostClient<HostRpcRegistry> {
  const { client, localHostId, management } = input;
  const serve = buildMaintenanceFallbackServeMap(management);

  const shouldServe = (
    method: string,
  ): method is LocalMaintenanceFallbackMethod => {
    if (!isFallbackMethod(method)) return false;
    // The wrapped client must still address the host this decorator was
    // constructed for. `use-host-scope` rebuilds the decorator when the scope
    // moves, so a mismatch here is a transient (an unresolved row reports
    // `null`) — delegating is the safe answer in every such state.
    if (client.getActiveHostId() !== localHostId) return false;
    // Live handshake answer, read per call: `null` (no handshake yet) and
    // `true` both delegate — only a definitive `false` routes to the IPC
    // lane. A host upgraded in place re-handshakes, the registry flips, and
    // this same read makes every later call delegate with no rebuild.
    const negotiated = getNegotiatedHostMethods(localHostId);
    if (negotiated === null) return false;
    return !negotiated.has(method);
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
            : target.request(method, params);
      }
      if (property === "requestWithSignal") {
        // The IPC leg has no cancellation to thread, so a served call ignores
        // the signal — it is short-lived and its answer is cache-safe.
        return <Method extends keyof HostRpcRegistry & string>(
          method: Method,
          params: RequestOfMethod<HostRpcRegistry, Method>,
          signal: AbortSignal | undefined,
        ) =>
          shouldServe(method)
            ? serveFallbackRequest<Method>(serve, method, params)
            : target.requestWithSignal(method, params, signal);
      }
      if (property === "requestWithResponseTimeout") {
        // None of the intercepted four is a long-poll method today; this is
        // intercepted anyway so a future hook migration cannot silently route
        // an intercepted method back onto a transport the handshake refused.
        return <Method extends keyof HostRpcRegistry & string>(
          method: Method,
          params: RequestOfMethod<HostRpcRegistry, Method>,
          responseTimeoutMs: number,
        ) =>
          shouldServe(method)
            ? serveFallbackRequest<Method>(serve, method, params)
            : target.requestWithResponseTimeout(
                method,
                params,
                responseTimeoutMs,
              );
      }
      // Same fall-through discipline as `createPinnedRequester`: everything
      // else binds to the wrapped client, which owns identity, context and
      // subscriptions. (`bind` on an already-bound member is a no-op, so a
      // wrapped pinned requester keeps its own interceptions intact.)
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const bound: unknown = value.bind(target);
      return bound;
    },
  });
}
