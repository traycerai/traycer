// Canonical install-generation fingerprint - Host Update Layer Redesign Tech Plan, "Unknown runtime identity - activationUnknown debt + one-time backfill".
// Legacy records written before the field existed have none, so they fall back to a tuple of fields that were already unique enough per install: `installedAt` + `archiveSha256` + `version`.

export interface InstallGenerationIdentity {
  readonly installId: string | null;
  readonly installedAt: string;
  readonly archiveSha256: string | null;
  readonly version: string;
}

const INSTALL_ID_PREFIX = "id:";
const LEGACY_PREFIX = "legacy:";
// Field separator for the legacy tuple.
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
