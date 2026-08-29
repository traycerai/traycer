/**
 * A host-credential mint request, typed BY the contract.
 *
 * This exists because two fixtures invented an arm. `reason` is
 * `Exclude<HostCredentialState, "active">` - `"missing" | "needs-reauth"` - and
 * both suites wrote `"absent"`, which is a real arm of `BearerPush.state` and
 * of nothing else. The two unions sit inches apart in the same test files, the
 * word reads correctly in English, and every one of those tests PASSED: the
 * value only had to survive `structuredClone` and reach a `vi.fn()`, and a
 * string does that whatever it says.
 *
 * It is the same defect the production `RevalidateOutcome` parser had earlier
 * in this ticket ("unchanged" and "failed" existed nowhere), and the rule is
 * the one that catches both: a literal that mirrors a contract type must be
 * TYPED by that contract, so an arm the contract lacks cannot be spelled. An
 * inline object literal in an argument position is inferred, not checked
 * against anything - which is exactly how a fixture comes to describe a state
 * the system has no name for.
 *
 * One site rather than three, for the reason every other collapse in this tree
 * has: three literals mean three places for the next contract change to be
 * missed in, and the two that were wrong were wrong identically.
 */
import type { HostCredentialMintRequest } from "@traycer-clients/shared/host-transport/host-credential-mint-flow";

export function mintRequestFixture(
  overrides: Partial<HostCredentialMintRequest>,
): HostCredentialMintRequest {
  // `missing` rather than `needs-reauth`: it is the ordinary case - a host that
  // has never held a credential - and `needs-reauth` names a dead refresh
  // family, which is a more specific claim than a default should make.
  return { hostId: "host-1", reason: "missing", ...overrides };
}
