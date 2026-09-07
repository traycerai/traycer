import type { AttemptLiveness } from "@traycer/protocol/config/host-update-attempt-liveness";
import { deriveAttemptLiveness as deriveAttemptLivenessCore } from "@traycer/protocol/config/host-update-attempt-liveness";
import type { HostUpdateAttemptRead } from "./decode";
import type { AttemptHolderEvidence } from "./lock";

// Read-side interruption derivation (§1.5).
// The derivation moved to `@traycer/protocol/config/host-update-attempt-liveness`, for the reason given in `./record`: `traycer-host` derives the same verdict from the same record and cannot import this package.

export type { AttemptLiveness };

export {
  RECOMMENDED_ATTEMPT_STALENESS_MS,
  attemptHolderProbeRequired,
} from "@traycer/protocol/config/host-update-attempt-liveness";

export interface AttemptLivenessInput {
  readonly current: HostUpdateAttemptRead;
  readonly holder: AttemptHolderEvidence;
  readonly nowMs: number;
  readonly stalenessMs: number;
}

export const deriveAttemptLiveness: (
  input: AttemptLivenessInput,
) => AttemptLiveness = deriveAttemptLivenessCore;

type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

const _livenessInputSurfacesAgree: MutuallyAssignable<
  Parameters<typeof deriveAttemptLiveness>[0],
  AttemptLivenessInput
> = true;
void _livenessInputSurfacesAgree;
