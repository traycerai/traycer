// Cross-platform process liveness + identity probing. The mechanics live
// in `@traycer-clients/shared/host-lock/process-identity` (Host Update
// Layer Redesign Tech Plan, "cli-lock" rule 3: this module's identity
// checks must agree byte-for-byte with the CLI's own `cli-lock` hardening,
// so a single implementation backs both). This file re-exports the
// desktop-facing names so every existing import path in this package
// keeps working unchanged.
export {
  __parseElapsedSecondsForTest,
  __setAsyncProcessLivenessReaderForTest,
  __setAsyncProcessStartTimeReaderForTest,
  computeProcessIdentityVerdict,
  currentProcessIdentityToken,
  getPublishedProcessIdentityVerdict,
  isPublishedProcessIdentityCurrent,
  isProcessAlive,
  readProcessStartTimeMs,
  verifyProcessIdentity,
  type ProcessIdentityToken,
  type ProcessIdentityVerdict,
  type ProcessLivenessVerdict,
  type PublishedProcessIdentityVerdict,
} from "@traycer-clients/shared/host-lock/process-identity";
