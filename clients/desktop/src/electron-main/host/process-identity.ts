// The mechanics live in `@traycer-clients/shared/host-lock/process-identity` (Host Update Layer Redesign Tech Plan, "cli-lock" rule 3: this module's identity checks must agree.
export {
  __parseElapsedSecondsForTest,
  __setAsyncProcessLivenessReaderForTest,
  __setAsyncProcessStartIdentityReaderForTest,
  __setAsyncProcessStartTimeReaderForTest,
  computeProcessIdentityVerdict,
  currentProcessIdentityToken,
  getPublishedProcessIdentityVerdict,
  isProcessAlive,
  readProcessStartIdentity,
  readProcessStartTimeMs,
  verifyProcessIdentity,
  type ProcessIdentityToken,
  type ProcessIdentityVerdict,
  type ProcessLivenessVerdict,
  type PublishedProcessIdentityVerdict,
} from "@traycer-clients/shared/host-lock/process-identity";
