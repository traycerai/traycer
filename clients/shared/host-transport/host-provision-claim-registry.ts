/**
 * Cross-realm arbitration for delegated host-credential provisioning.
 *
 * The renderer's `appHostCredentialMintFlow` already guarantees one prompt per
 * host WITHIN a module realm. Every Electron `BrowserWindow` is its own realm,
 * though, so two windows connected to the same un-provisioned host would each
 * notice `missing` and each raise an email-OTP dialog. This registry is the
 * single arbiter both consult; on desktop it lives in the main process, above
 * every window.
 *
 * It is deliberately a plain object with an injected clock rather than anything
 * Electron-shaped, so the mock shell can hold one too - gui-app tests run
 * against the mock, and a policy that only exists on the real desktop is a
 * policy no test ever exercises.
 *
 * The registry answers one question - "may I be the one to ask about this
 * host?" - and remembers, per signed-in identity, which hosts have already been
 * asked about. It never sees a CREDENTIAL: the mint itself stays where it was,
 * and the only token here names a claim.
 */

/**
 * The answer to "may I be the one to ask about this host?".
 *
 * A grant carries an opaque token that `release` requires back. Identifying a
 * claim by `(hostId, holder)` alone is not enough: one holder can legitimately
 * hold TWO different claims on the same host over time - claim, identity
 * change resets the registry, claim again - and a stale release from the first
 * would otherwise match the second and settle a host nobody has answered for.
 * The token also makes the TTL-takeover guard structural rather than a
 * comparison someone could delete without a test noticing.
 */
export type HostProvisionClaim =
  | { readonly kind: "granted"; readonly token: string }
  | { readonly kind: "denied" };

/**
 * How long an unreleased claim is honored before another holder may take it.
 *
 * A holder normally releases in a `finally`, and a holder that disappears is
 * pruned by `retainHolders`. Neither covers a renderer that RELOADS: the
 * document (and with it the in-flight release) is gone, but the webContents id
 * survives, so the claim would otherwise wedge this host for the rest of the
 * app's life. Generous enough that a user reading an email and typing a code is
 * never overtaken - a claim this old is abandoned, not slow. The cost of being
 * wrong is one duplicate dialog, which is exactly the state we were in before.
 */
export const HOST_PROVISION_CLAIM_TTL_MS = 10 * 60_000;

interface ActiveClaim {
  readonly token: string;
  readonly holderId: number;
  readonly claimedAtMs: number;
}

export class HostProvisionClaimRegistry {
  private readonly activeByHostId = new Map<string, ActiveClaim>();
  private readonly settledHostIds = new Set<string>();
  private readonly now: () => number;
  /**
   * Monotonic across `reset()` on purpose - a token must never be reused, or a
   * release held over an identity change could match a later claim.
   */
  private nextTokenSeq = 1;

  constructor(now: () => number) {
    this.now = now;
  }

  /**
   * Grants at most one holder the right to prompt for `hostId`. Denied when
   * another holder is mid-prompt, or when this host has already been asked
   * about during the current identity - a decline is an answer, and re-asking
   * on every new window is the behavior this exists to stop.
   */
  claim(hostId: string, holderId: number): HostProvisionClaim {
    if (this.settledHostIds.has(hostId)) {
      return { kind: "denied" };
    }
    const existing = this.activeByHostId.get(hostId);
    if (
      existing !== undefined &&
      this.now() - existing.claimedAtMs < HOST_PROVISION_CLAIM_TTL_MS
    ) {
      return { kind: "denied" };
    }
    const token = `claim-${this.nextTokenSeq}`;
    this.nextTokenSeq += 1;
    this.activeByHostId.set(hostId, {
      token,
      holderId,
      claimedAtMs: this.now(),
    });
    return { kind: "granted", token };
  }

  /**
   * Ends the holder's turn and records that this host has been asked about,
   * whatever the answer was. Provisioned, declined, and failed all settle the
   * same way: the recovery door is the next app run, not a dialog loop.
   *
   * Ignored unless the token names the claim that is currently active - a
   * holder overtaken on the TTL, or one whose claim a registry reset threw
   * away, must not settle a host out from under whoever holds it now.
   */
  release(hostId: string, token: string): void {
    const existing = this.activeByHostId.get(hostId);
    if (existing === undefined || existing.token !== token) {
      return;
    }
    this.activeByHostId.delete(hostId);
    this.settledHostIds.add(hostId);
  }

  /**
   * Drops claims held by holders that no longer exist (a window closed
   * mid-prompt). Deliberately does NOT settle those hosts: nobody answered, so
   * the next window is free to ask.
   */
  retainHolders(liveHolderIds: ReadonlySet<number>): void {
    for (const [hostId, claim] of this.activeByHostId) {
      if (!liveHolderIds.has(claim.holderId)) {
        this.activeByHostId.delete(hostId);
      }
    }
  }

  /**
   * Forgets everything. Must run when the signed-in identity changes: the memo
   * is keyed by hostId alone, so without this the next user on this machine
   * would silently never be offered provisioning for a host the PREVIOUS user
   * declined.
   */
  reset(): void {
    this.activeByHostId.clear();
    this.settledHostIds.clear();
  }
}
