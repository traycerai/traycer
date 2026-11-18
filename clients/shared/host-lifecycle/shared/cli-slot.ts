// CLI-slot validity evidence (plan F8). The slot is a symlink; the probe
// reports validity without healing (heal is an app capability).

export type CliSlotValidity =
  /**
   * Structurally valid slot. `attested` reports whether the **invocation**
   * probe positively ran and passed — it is not a restatement of `kind`.
   *
   * It was a literal `true`, which carried no information and conflated
   * structural validity (the symlink resolves to an executable at the
   * expected target) with invocation attestation (the binary answered
   * `host start --help`). That is exactly the distinction the F8 phase-2
   * probe exists to make, and a caller reading `attested` got `true` for a
   * slot whose invocation probe had never been run.
   */
  | { readonly kind: "valid"; readonly attested: boolean }
  | { readonly kind: "dangling" }
  | { readonly kind: "wrong-target" }
  | { readonly kind: "not-executable" }
  | { readonly kind: "indeterminate"; readonly cause: string }
  | { readonly kind: "absent" };

export type CliSlotProbeInput = {
  /** Slot path exists as a path entry (file/symlink). */
  readonly slotExists: boolean;
  /** When exists: whether it is a symlink (or plain file we treat as slot). */
  readonly isLinkOrFile: boolean;
  /** Resolved target path, or null if dangling. */
  readonly resolvedTarget: string | null;
  /** Expected target path when known (bundle CLI / managed install). */
  readonly expectedTarget: string | null;
  /** Resolved target is executable by the current user. */
  readonly executable: boolean;
  /** Optional positive invocation probe result (F8 phase-2 style). */
  readonly invocationAttested: boolean | null;
  /** Probe I/O error message, when the probe itself failed. */
  readonly probeError: string | null;
};

/**
 * Pure classification of CLI-slot state from pre-gathered fs facts.
 */
export function classifyCliSlot(input: CliSlotProbeInput): CliSlotValidity {
  if (input.probeError !== null) {
    return { kind: "indeterminate", cause: input.probeError };
  }
  if (!input.slotExists) {
    return { kind: "absent" };
  }
  if (!input.isLinkOrFile) {
    return { kind: "indeterminate", cause: "slot-path-not-file-or-link" };
  }
  if (input.resolvedTarget === null) {
    return { kind: "dangling" };
  }
  if (
    input.expectedTarget !== null &&
    input.resolvedTarget !== input.expectedTarget
  ) {
    return { kind: "wrong-target" };
  }
  if (!input.executable) {
    return { kind: "not-executable" };
  }
  if (input.invocationAttested === false) {
    return { kind: "indeterminate", cause: "invocation-probe-failed" };
  }
  // `null` = the invocation probe was not run, so the slot is structurally
  // valid but not invocation-attested.
  return { kind: "valid", attested: input.invocationAttested === true };
}
