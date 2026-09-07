// Cross-platform process liveness + identity probing.
// The mechanics live in `@traycer-clients/shared/host-lock/process-identity` (Host Update Layer Redesign Tech Plan, "cli-lock" rule 3: desktop main implements the IDENTICAL identity checks around its own SMAppService critical sections, so a single implementation backs both `cli-lock` hardening here and the desktop-held lock sections there).
export {
  __parseElapsedSecondsForTest,
  __setAsyncProcessStartIdentityReaderForTest,
  __setProcessStartTimeReaderForTest,
  computeProcessIdentityVerdict,
  currentProcessIdentityToken,
  getPublishedProcessIdentityVerdict,
  isProcessAlive,
  readLiveProcessStartTimeMs,
  readProcessStartIdentity,
  readProcessStartTimeMs,
  verifyProcessIdentity,
  verifyProcessIdentityAsync,
  type ProcessIdentityToken,
  type ProcessIdentityVerdict,
  type ProcessLivenessVerdict,
  type PublishedProcessIdentityVerdict,
} from "@traycer-clients/shared/host-lock/process-identity";
