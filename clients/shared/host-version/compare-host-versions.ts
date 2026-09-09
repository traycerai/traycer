// The comparator itself lives in `@traycer/protocol/host/version-order` (the
// host consumes it too, and cannot import this package). Re-exported here so
// the CLI's and desktop's existing import paths keep resolving to the one
// authority rather than growing a second copy.
export {
  compareHostVersions,
  isStrictlyNewerHostVersion,
  isValidHostVersion,
  type VersionComparisonResult,
  type VersionOrdering,
} from "@traycer/protocol/host/version-order";
