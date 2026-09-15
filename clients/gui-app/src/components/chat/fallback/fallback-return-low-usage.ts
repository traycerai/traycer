import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type {
  ProfileRateLimitSeverity,
  ProfileRateLimitSwitchPrompt,
} from "@/components/chat/composer/use-profile-rate-limit-switch-prompt";
import { profileCommitId } from "@/components/providers/provider-profile-model";
import { providerCliIdForHarness } from "@/lib/provider-ordering";

/**
 * Whether the return banner absorbs the composer's rate-limit advisory, and
 * with what.
 *
 * The banner OUTRANKS that advisory in `resolveComposerTopBannerKind`'s
 * one-at-a-time chain, so winning the slot silences it. Taking the slot and
 * dropping the sentence is what MF09 found: a user answering "Stay" lost the
 * one fact that argues against staying. UX §2 asks for one banner carrying both
 * facts, and these two functions are the rule that decides which facts.
 *
 * In its own module rather than beside the components that read it, for the
 * reason `fallback-notice-kinds.ts` gives for the same move: a `.tsx` exporting
 * a non-component breaks fast refresh and hides a testable rule inside a render
 * file. Everything here is decidable without rendering anything.
 */

/** The composer's advisory, reduced to the facts a banner needs. */
export interface ComposerRateLimitAdvisory {
  readonly providerId: ProviderId;
  /** Normalized commit id - `null` is the ambient (Terminal) account. */
  readonly profileId: string | null;
  readonly severity: ProfileRateLimitSeverity;
  /**
   * Model families named by the limits behind the warning. Empty means the
   * warning is profile-wide.
   */
  readonly limitedFamilies: ReadonlyArray<string>;
}

/**
 * The advisory as the composer's mount point supplies it.
 *
 * `signedOut` is the same suppression the composer's own `rateLimitVisible`
 * applies, and it has to be applied here too rather than left to the chain: a
 * signed-out gate with no provider/reason renders no reauth banner, so the
 * return banner can win the slot in a state where the advisory itself would
 * have been withheld. Absorbing a sentence the composer would not have shown is
 * the same defect as dropping one it would have, so one function answers both.
 */
export function composerRateLimitAdvisory(
  prompt: ProfileRateLimitSwitchPrompt,
  signedOut: boolean,
): ComposerRateLimitAdvisory | null {
  if (signedOut || prompt.kind !== "visible") return null;
  return {
    providerId: prompt.providerId,
    profileId: profileCommitId(prompt.current),
    severity: prompt.severity,
    limitedFamilies: prompt.limitedFamilies,
  };
}

/** What the banner renders, once the advisory is known to name this account. */
export interface FallbackReturnLowUsage {
  readonly severity: ProfileRateLimitSeverity;
  readonly limitedFamilies: ReadonlyArray<string>;
}

/**
 * The advisory the return banner absorbs - or `null`.
 *
 * The banner is offering to leave ONE account, so the only advisory worth
 * folding in is the one about THAT account. The composer's prompt is resolved
 * for the composer's own selection, and the two normally agree (a committed
 * switch moves the chat's settings, which is what the composer renders), but
 * "normally" is not a guarantee: the offer's `fallbackTuple` is the host's
 * durable record of where the chat runs, and a mid-flight selection change or a
 * stale render would otherwise attach one account's usage warning to a sentence
 * naming another. Naming the wrong account is worse than saying nothing, so the
 * match is required rather than assumed.
 *
 * BOTH halves of the identity are compared. The profile id alone is not enough:
 * the ambient account's id is `null` on every provider, so a Codex Terminal
 * account's advisory would match a Claude Code Terminal account's offer. The
 * provider comparison goes through `providerCliIdForHarness`, which is the same
 * mapping the advisory's own prompt used to pick its `providerId`.
 */
export function returnBannerLowUsage(
  advisory: ComposerRateLimitAdvisory | null,
  fallbackTuple: ChatRunSettings,
): FallbackReturnLowUsage | null {
  if (advisory === null) return null;
  const provider = providerCliIdForHarness(fallbackTuple.harnessId);
  if (advisory.providerId !== provider) return null;
  if (advisory.profileId !== fallbackTuple.profileId) return null;
  return {
    severity: advisory.severity,
    limitedFamilies: advisory.limitedFamilies,
  };
}
