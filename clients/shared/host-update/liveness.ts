import type { AttemptLiveness } from "@traycer/protocol/config/host-update-attempt-liveness";
import { deriveAttemptLiveness as deriveAttemptLivenessCore } from "@traycer/protocol/config/host-update-attempt-liveness";
import type { HostUpdateAttemptRead } from "./decode";
import type { AttemptHolderEvidence } from "./lock";

// Read-side interruption derivation (§1.5).
//
// THE DERIVATION MOVED to
// `@traycer/protocol/config/host-update-attempt-liveness`, for the reason
// given in `./record`: `traycer-host` derives the same verdict from the same
// record and cannot import this package. Interruption is the one conclusion
// in this whole layer that a projection is allowed to reach on its own, so
// two implementations of it was never an option.
//
// ### This module exports the protocol FUNCTION under THIS package's SIGNATURE
//
// The distinction is load-bearing and was got wrong once. `AttemptLivenessInput`
// below is this package's own: its `holder` is the rich
// `AttemptHolderEvidence`, whose `holder-live` arm carries `LockMetadata`. The
// protocol function deliberately takes a NARROWER structural observation - it
// reads only `kind` and `cause` - so that the host, which has no `LockMetadata`,
// can call the same derivation.
//
// Re-exporting the protocol function bare made those two disagree while both
// compiles stayed green, because no in-repo caller reflects the parameter type:
//
//   - a downstream caller writing `Parameters<typeof deriveAttemptLiveness>[0]`,
//     narrowing `holder-live`, and reading `holder.holder.pid` compiled against
//     the pre-move signature and would now fail - the payload was erased from
//     the type it gets back;
//   - and conversely a fresh `{ kind: "holder-live" }` with no `LockMetadata`
//     started compiling through this package's API, bypassing the payload
//     contract that deliberately stayed here.
//
// So the same function OBJECT is exported (one implementation, no wrapper, no
// second copy of the algebra) under an explicit signature stated in this
// package's own vocabulary. Two independent checks keep that honest, and both
// are compile-time:
//
//   1. the initializer below - protocol's function must remain assignable to
//      this signature, which requires the rich input to stay assignable to the
//      narrow one;
//   2. `_livenessInputSurfacesAgree` - the exported callable's parameter and
//      the exported `AttemptLivenessInput` must be MUTUALLY assignable. A
//      future edit that "simplifies" this back to a bare re-export makes that
//      parameter protocol's narrow type again and fails this line.

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
