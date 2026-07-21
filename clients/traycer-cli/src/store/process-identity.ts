// Cross-platform process liveness + identity probing. The mechanics live
// in `@traycer-clients/shared/host-lock/process-identity` (Host Update
// Layer Redesign Tech Plan, "cli-lock" rule 3: desktop main implements the
// IDENTICAL identity checks around its own SMAppService critical sections,
// so a single implementation backs both `cli-lock` hardening here and the
// desktop-held lock sections there). This file re-exports the CLI-facing
// names so every existing import path in this package (`../store/process-
// identity`, `./process-identity`) keeps working unchanged.
export {
  __parseElapsedSecondsForTest,
  __setProcessStartTimeReaderForTest,
  computeProcessIdentityVerdict,
  currentProcessIdentityToken,
  isProcessAlive,
  readLiveProcessStartTimeMs,
  readProcessStartTimeMs,
  verifyProcessIdentity,
  type ProcessIdentityToken,
  type ProcessIdentityVerdict,
  type ProcessLivenessVerdict,
} from "@traycer-clients/shared/host-lock/process-identity";
