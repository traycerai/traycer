/**
 * Client remote transport (Ticket T12) — a persistent, E2E-encrypted, multiplexed
 * session behind the same `IHostMessenger` / `IStreamClient` interfaces the local
 * transports implement, selected by `HostDirectoryEntry.kind === "remote"`.
 *
 * The client↔host mux wire contract this transport speaks is documented for the
 * T11 host responder in `../host-client/REMOTE-TRANSPORT.md` and codified in
 * `@traycer/protocol/host-transport/mux`.
 */

export {
  createRemoteHostTransport,
  type CreateRemoteTransportOptions,
  type RemoteHostTransport,
} from "./create-remote-transport";
export {
  RemoteSession,
  type RemoteSessionOptions,
  type IRemoteSession,
} from "./remote-session";
export { RemoteHostMessenger } from "./remote-host-messenger";
export { RemoteStreamClient } from "./remote-stream-client";
export {
  acquireRemoteSession,
  hasReadyRemoteSession,
  remoteSessionCacheKey,
  retireAllRemoteSessions,
  wakeHeldRemoteSessions,
  subscribeRemoteSessionReadiness,
  resetRemoteSessionReadinessListenersForTest,
} from "./active-remote-sessions";
export {
  mintAttachGrantViaHttp,
  createAttachGrantProvider,
  type AttachGrant,
  type AttachGrantResult,
  type AttachGrantProvider,
  type AttachGrantProvision,
} from "./grant-client";
export { PLAN_RESTRICTED_FATAL_CODE } from "./remote-session";
export {
  decodeHostPublicKey,
  InvalidHostPublicKeyError,
} from "./noise-channel";
export {
  MuxFrameType,
  QosClass,
  MuxFlags,
  CURRENT_MUX_VERSION,
  NOISE_PROLOGUE,
  type MuxFrame,
  type SessionOpenPayload,
  type SessionOpenAckPayload,
} from "@traycer/protocol/host-transport/mux";
