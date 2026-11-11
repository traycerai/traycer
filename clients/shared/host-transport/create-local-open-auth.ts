import type { FirstPartyClientIdentity } from "@traycer/protocol/framework/index";
import type { MemberCredentialHandoff } from "@traycer/protocol/host-transport/mux";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import type { OpenFrameBearerSource } from "../auth/bearer-source";
import type { ServerClockSkewSignal } from "../clock/server-time-offset-tracker";
import { NO_TRANSPORT_EVIDENCE } from "../host-selection/transport-evidence";
import type { HostTransportEndpoint } from "./host-messenger";
import {
  LocalOpenAuth,
  TEAM_MEMBERSHIP_REQUIRED,
  TEAM_MEMBERSHIP_REQUIRED_MESSAGE,
  type LocalMemberReadiness,
  type LocalTeamAdmissionState,
} from "./local-open-auth";
import { createSandboxAttachGrantProvider } from "./remote/grant-client";
import type { IStreamSession } from "./i-stream-session";
import type { IStreamWebSocketFactory } from "./ws-stream-factory";
import { WsStreamClient } from "./ws-stream-client";
import {
  DEFAULT_DIAL_TIMEOUT_MS,
  DEFAULT_INITIAL_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_OPEN_ACK_TIMEOUT_MS,
  DEFAULT_PING_INTERVAL_MS,
  DEFAULT_PONG_TIMEOUT_MS,
} from "./transport-config";

export interface CreateLocalOpenAuthOptions {
  readonly authnBaseUrl: string;
  readonly cloudAuthorized: () => boolean;
  readonly webSocketFactory: IStreamWebSocketFactory;
  readonly clientIdentity: FirstPartyClientIdentity;
  readonly clock: ServerClockSkewSignal | null;
  readonly mintMemberCredential: (
    hostId: string,
    bearer: OpenFrameBearerSource,
    signal: AbortSignal,
  ) => Promise<MemberCredentialHandoff | null>;
  readonly onMemberCredentialAdopted: (
    hostId: string,
    credential: MemberCredentialHandoff,
  ) => void;
  readonly onAdmissionInvalidated?: (hostId: string) => void;
  readonly onAdmissionState?: (
    hostId: string,
    userId: string,
    state: LocalTeamAdmissionState,
  ) => void;
}

/** One mint implementation for both GUI and CLI local admission. */
export function createLocalOpenAuth(
  options: CreateLocalOpenAuthOptions,
): LocalOpenAuth {
  // A mint that lost its socket still has one delivery owner. Keep it on its
  // originating lease, never copy it to a different account or mint over it.
  const undelivered = new WeakMap<
    OpenFrameBearerSource,
    Map<string, MemberCredentialHandoff>
  >();
  const auth = new LocalOpenAuth({
    onAdmissionState: options.onAdmissionState,
    onAdmissionInvalidated: options.onAdmissionInvalidated,
    mintSessionGrant: async (hostId, bearer, signal) => {
      const grants = createSandboxAttachGrantProvider({
        authnBaseUrl: options.authnBaseUrl,
        hostId,
        purpose: "local",
        signal,
        getBearerToken: () =>
          options.cloudAuthorized() ? bearer.getBearerToken() : null,
      });
      const result = await grants.provider();
      if (result.kind === "refused") {
        return {
          kind: "refused",
          fatal:
            result.fatal.code === TEAM_MEMBERSHIP_REQUIRED
              ? { ...result.fatal, reason: TEAM_MEMBERSHIP_REQUIRED_MESSAGE }
              : result.fatal,
        };
      }
      if (result.kind !== "ok")
        return { kind: "unavailable", retryCause: result.retryCause };
      const token = grants.readSessionGrant();
      return token === null ? { kind: "unavailable" } : { kind: "ok", token };
    },
    provisionMember: async (endpoint, bearer, signal) => {
      let pending = undelivered.get(bearer);
      if (pending === undefined) {
        pending = new Map();
        undelivered.set(bearer, pending);
      }
      const pendingForLease = pending;
      const pendingKey = `${endpoint.hostId}\u0000${auth.revisionFor(endpoint.hostId)}`;
      return provisionLocalMember({
        options,
        auth,
        endpoint,
        bearer,
        signal,
        mint: async () => {
          const held = pendingForLease.get(pendingKey);
          if (held !== undefined) return held;
          const credential = await options.mintMemberCredential(
            endpoint.hostId,
            bearer,
            signal,
          );
          if (credential !== null) pendingForLease.set(pendingKey, credential);
          return credential;
        },
        onSent: () => pendingForLease.delete(pendingKey),
      });
    },
  });
  return auth;
}

function provisionLocalMember(input: {
  readonly options: CreateLocalOpenAuthOptions;
  readonly auth: LocalOpenAuth;
  readonly endpoint: HostTransportEndpoint;
  readonly bearer: OpenFrameBearerSource;
  readonly signal: AbortSignal;
  readonly mint: () => Promise<MemberCredentialHandoff | null>;
  readonly onSent: () => void;
}): Promise<LocalMemberReadiness> {
  const { options, endpoint, bearer, signal } = input;
  if (signal.aborted) return Promise.resolve({ kind: "unavailable" });
  let handedOff: MemberCredentialHandoff | null = null;
  const client = new WsStreamClient<HostStreamRpcRegistry>({
    registry: hostStreamRpcRegistry,
    hostId: endpoint.hostId,
    endpoint: () => endpoint,
    bearer: () => bearer,
    userId: bearer.identity.userId,
    cloudAuthorized: options.cloudAuthorized,
    localOpenAuth: input.auth,
    // Only this internal control stream bypasses the member readiness gate.
    localMemberProvision: {
      mint: () => input.mint(),
      onSent: (credential) => {
        handedOff = credential;
        input.onSent();
      },
    },
    auth: null,
    clock: options.clock,
    hostCredentialMint: null,
    onHostCredentialState: null,
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: options.webSocketFactory,
    dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS,
    openAckTimeoutMs: DEFAULT_OPEN_ACK_TIMEOUT_MS,
    pingIntervalMs: DEFAULT_PING_INTERVAL_MS,
    pongTimeoutMs: DEFAULT_PONG_TIMEOUT_MS,
    initialBackoffMs: DEFAULT_INITIAL_BACKOFF_MS,
    maxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
    clientIdentity: options.clientIdentity,
  });
  return new Promise((resolve) => {
    let settled = false;
    let session: IStreamSession | null = null;
    const finish = (result: LocalMemberReadiness): void => {
      if (settled) return;
      settled = true;
      clearTimeout(bound);
      signal.removeEventListener("abort", aborted);
      session?.close();
      client.close("local-member-provision-complete");
      resolve(result);
    };
    const aborted = (): void => finish({ kind: "unavailable" });
    const bound = setTimeout(() => finish({ kind: "unavailable" }), 30_000);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) {
      aborted();
      return;
    }
    // No resume cursor: every fresh subscription gets a bounded initial
    // catch-up, including on team hosts that omit notification streams.
    session = client.subscribe("worktree.changed", {});
    session.onServerFrame((frame) => {
      if (frame.kind !== "changed" || handedOff === null) return;
      // This exact subscription crossed the host's intake wait AFTER its
      // member frame. An unrelated socket's OPEN_ACK proves none of this.
      // The root catch-up is only a fence; none of its content is consumed.
      options.onMemberCredentialAdopted(endpoint.hostId, handedOff);
      finish({ kind: "ready" });
    });
    session.onStatusChange((status, reason, retryCause) => {
      if (status === "closed") {
        finish(
          reason?.kind === "fatalError"
            ? { kind: "refused", fatal: reason.details }
            : { kind: "unavailable" },
        );
      } else if (status === "reconnecting" && retryCause !== null) {
        finish({ kind: "unavailable", retryCause });
      }
    });
  });
}
