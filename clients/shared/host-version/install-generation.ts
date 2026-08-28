// Canonical install-generation fingerprint - Host Update Layer Redesign Tech
// Plan, "Unknown runtime identity - activationUnknown debt + one-time
// backfill". A single, shared encoding so the CLI (which mints and attests
// the fingerprint) and desktop main (which captures/forwards it to
// `host stamp-runtime`) agree byte-for-byte without duplicating the
// algorithm - the exact reason the SemVer comparator lives here too.
//
// `installId` (minted at every record materialization, additive field) is
// the fingerprint whenever present. Legacy records written before the field
// existed have none, so they fall back to a tuple of fields that were
// already unique enough per install: `installedAt` + `archiveSha256` +
// `version`. The tuple is folded into one string (not compared field-by-
// field) so callers - the CAS in `host stamp-runtime` in particular - can
// use plain string equality regardless of which shape produced it.

export interface InstallGenerationIdentity {
  readonly installId: string | null;
  readonly installedAt: string;
  readonly archiveSha256: string | null;
  readonly version: string;
}

// Tag-prefixed so the two encodings can never collide with each other (an
// `installId` string and a legacy tuple string live in disjoint namespaces
// even if one happened to look like the other) and so a caller reading a
// raw fingerprint string back can tell which shape produced it without a
// side channel.
const INSTALL_ID_PREFIX = "id:";
const LEGACY_PREFIX = "legacy:";
// Field separator for the legacy tuple. None of the three fields can
// contain it: `installedAt` is an ISO-8601 timestamp, `archiveSha256` is a
// 64-char lowercase hex digest (or literally absent), and `version` is
// either a valid SemVer string or this CLI's `local-<basename>-<stamp>`
// synthetic form - none of those alphabets include `|`.
const LEGACY_SEPARATOR = "|";

export function encodeInstallGeneration(
  identity: InstallGenerationIdentity,
): string {
  if (identity.installId !== null) {
    return `${INSTALL_ID_PREFIX}${identity.installId}`;
  }
  return [
    LEGACY_PREFIX + identity.installedAt,
    identity.archiveSha256 ?? "",
    identity.version,
  ].join(LEGACY_SEPARATOR);
}
