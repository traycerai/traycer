/**
 * Desktop IPC re-export of the shared device-flow result contracts. The
 * canonical definitions live in `@traycer-clients/shared/platform/runner-host`;
 * this file lets the Electron preload bridge import them from
 * `src/ipc-contracts/` (per the preload boundary rule) rather than reaching into
 * the shared package, mirroring how `auth-types.ts` re-exports the auth
 * contract. The wire shapes are structurally identical to the shared types.
 */
export type {
  DeviceFlowAuthorization,
  DeviceFlowResult,
} from "@traycer-clients/shared/platform/runner-host";
