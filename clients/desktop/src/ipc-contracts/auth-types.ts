/**
 * Desktop IPC re-export of the shared auth result contracts. The canonical
 * definitions live in `@traycer-clients/shared/platform/runner-host`; this file
 * lets the Electron preload bridge import them from `src/ipc-contracts/` (per
 * the preload boundary rule) rather than reaching into the shared package,
 * mirroring how `host-management-types.ts` re-exports the host contract.
 */
export type { AuthTokenRefreshResult } from "@traycer-clients/shared/platform/runner-host";
