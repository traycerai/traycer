/**
 * Wording shared by the surfaces that report a profile's rate-limit state.
 *
 * There are two of them and they must not drift: the composer's own advisory
 * banner (`chat/composer/profile-rate-limit-switch-banner.tsx`) and the
 * fallback return banner, which ABSORBS that advisory's sentence when it takes
 * the composer's one-at-a-time slot (MF09, UX §2). A user who sees the absorbed
 * clause in one message and the full advisory in the next must be reading one
 * finding worded one way, not two findings that happen to be about the same
 * account.
 *
 * A `.ts` in `lib/`, deliberately, rather than an export from either surface:
 * both callers are `.tsx`, and a non-component export from a `.tsx` breaks fast
 * refresh. Pointing the fallback copy at the composer's module would also
 * invert the dependency - a chat surface reaching into a composer surface for a
 * sentence.
 */

/**
 * `"Fable "` / `"Fable, Opus "`, or `""` when the limit is profile-wide.
 *
 * The trailing space is part of the value rather than the caller's template:
 * every call site interpolates it mid-sentence (`"has reached its
 * ${qualifier}rate limit"`), and a caller that added its own space would emit a
 * double space in the profile-wide case - which is exactly the kind of thing
 * that survives review and shows up in a screenshot.
 */
export function limitedFamilyQualifier(
  limitedFamilies: ReadonlyArray<string>,
): string {
  return limitedFamilies.length === 0 ? "" : `${limitedFamilies.join(", ")} `;
}
