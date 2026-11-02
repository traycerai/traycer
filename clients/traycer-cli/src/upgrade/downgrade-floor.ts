import { compareHostVersions } from "@traycer-clients/shared/host-version/compare-host-versions";

// The floor every CLI self-upgrade path publishes bytes against: the
// version already installed.
//
// WHY THIS EXISTS. The CLI release feed is ROLLING and publishes STABLE
// builds only (see `registry/cli-versions.ts`): its `version` is whatever
// the last stable release was, not an upper bound. A machine running a
// prerelease is therefore ABOVE the feed, and a self-upgrade path that
// only asks "is the feed's version the string I have?" answers "no" and
// proceeds - installing 1.5.1 over 1.5.2-rc.1 and reporting it as an
// upgrade. Measured on a 1.5.2-rc.1 Linux box: `cli upgrade --dry-run`
// targeted 1.5.1.
//
// So the comparison is an ORDERING, not an equality, and it must count
// prerelease identifiers: 1.5.2-rc.1 is above 1.5.1 and below 1.5.2.
// `compareHostVersions` is that one authority (SemVer §11 precedence,
// prerelease included), shared with `host update`'s own downgrade guard so
// the two cannot drift into disagreeing about the same pair of versions.
//
// WHAT IT DOES NOT DECIDE. Only whether publishing `candidateVersion` over
// `installedVersion` moves BACKWARDS. Whether a backwards move is allowed
// is the caller's: an explicitly named version is consent and goes through
// (`cli upgrade --target`, `host update --release --allow-downgrade`),
// while an unqualified "bring me up to date" never does.

/**
 * Whether installing `candidateVersion` over `installedVersion` would move
 * the CLI backwards.
 *
 * `false` means "not proven to be a downgrade", which is the honest reading
 * of an INCOMPARABLE pair rather than a second meaning smuggled into the
 * same answer. An installed version this comparator cannot parse is a
 * hand-anchored or locally-built CLI (`cli re-anchor --installed-version`
 * takes any string, and a dev build may stamp `local-<name>-<ms>`); the
 * feed's own version is always valid SemVer. Refusing on "can't tell" would
 * leave such an install with no self-upgrade route at all, to prevent a
 * downgrade nobody can demonstrate - so this fails open, in the one
 * direction the protocol comparator reserves incomparability for (the
 * INSTALLED side).
 */
export function wouldDowngradeCli(opts: {
  readonly installedVersion: string;
  readonly candidateVersion: string;
}): boolean {
  const comparison = compareHostVersions(
    opts.candidateVersion,
    opts.installedVersion,
  );
  return comparison.comparable && comparison.ordering === "less";
}
