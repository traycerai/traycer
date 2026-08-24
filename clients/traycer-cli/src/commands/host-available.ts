import {
  isCanonicalReleaseCandidate,
  isPreReleaseVersion,
} from "@traycer-clients/shared/host-version/release-line";
import type { HostIncludePreReleasesSource } from "@traycer/protocol/host/maintenance/schemas";
import {
  createDefaultRegistryClient,
  currentHostPlatformKey,
  resolveManifestUrl,
} from "../registry";
import {
  evaluateHostClientFloor,
  isHostClientFloorRefusal,
} from "../registry/client-floor";
import { resolveCliVersion } from "../cli-version";
import { readHostInstallRecord } from "../manifest/host-install";
import type {
  HostPlatformKey,
  HostVersionEntry,
  HostVersionsManifest,
} from "../registry";
import type { Environment } from "../runner/environment";
import type {
  CommandContext,
  CommandFn,
  CommandResult,
} from "../runner/runner";

interface HostAvailableArgs {
  /**
   * The catalog override: `true` explicitly includes release candidates,
   * `false` explicitly filters them out, and `null` means the caller stated
   * nothing and wants the default derived from the installed host.
   *
   * Three states, not two, because "unchecked" and "never touched" are
   * different requests once an RC host includes its own line by default:
   * collapsing them would leave a user on an RC host with no way to get a
   * stable-only listing.
   */
  readonly includePreReleases: boolean | null;
}

interface HostAvailableListingArgs {
  readonly manifest: HostVersionsManifest;
  readonly manifestUrl: string;
  readonly platformKey: HostPlatformKey;
  readonly includePreReleases: boolean;
  readonly includePreReleasesSource: HostIncludePreReleasesSource;
  /** THIS CLI's version - the floor is about the runner, not the archive. */
  readonly cliVersion: string;
}

interface HostAvailableListing {
  readonly manifest: HostVersionsManifest;
  readonly human: string;
}

export interface ResolvedIncludePreReleases {
  readonly includePreReleases: boolean;
  readonly source: HostIncludePreReleasesSource;
}

/**
 * The CLI is the catalog-default authority: it is the only process that reads
 * this environment's install record, so it - not the GUI, and not the host
 * resolver - decides what an unstated override means.
 *
 * An installed canonical `X.Y.Z-rc.N` includes pre-releases so the RC can see
 * its own line. EVERY other installed state resolves stable-only: a stable
 * host, a non-canonical pre-release (`beta`, `nightly`, a `local-*` pin), no
 * install at all, and an install record that could not be read. That last one
 * is the point of `installedHostVersion: null` collapsing absent and
 * unreadable together - see `readInstalledHostVersionFailingClosed`.
 */
export function resolveIncludePreReleases(args: {
  readonly override: boolean | null;
  readonly installedHostVersion: string | null;
}): ResolvedIncludePreReleases {
  if (args.override === true) {
    return { includePreReleases: true, source: "explicit-include" };
  }
  if (args.override === false) {
    return { includePreReleases: false, source: "explicit-exclude" };
  }
  if (
    args.installedHostVersion !== null &&
    isCanonicalReleaseCandidate(args.installedHostVersion)
  ) {
    return { includePreReleases: true, source: "installed-rc" };
  }
  return { includePreReleases: false, source: "stable-default" };
}

/**
 * Reads the installed host's version for the derivation above, failing closed.
 *
 * Every failure mode collapses to `null` (stable-default), deliberately. This
 * read exists only to pick a DEFAULT FILTER for a listing; a corrupt or
 * unreadable `install.json` is not a reason to refuse to tell someone which
 * host versions exist - that is exactly the moment they are most likely to be
 * reinstalling. `readHostInstallRecord` is the strict reader used by the
 * install/start paths, and it throws `HOST_INSTALL_RECORD_INVALID` rather than
 * overwrite a suspect record; that strictness is right there and wrong here,
 * so this catches it along with permission and I/O errors.
 */
async function readInstalledHostVersionFailingClosed(
  environment: Environment,
  ctx: CommandContext,
): Promise<string | null> {
  try {
    const record = await readHostInstallRecord(environment);
    return record === null ? null : record.version;
  } catch (err) {
    ctx.runtime.logger.debug(
      "Host install record unreadable; defaulting catalog to stable-only",
      {
        environment,
        errorName: err instanceof Error ? err.name : typeof err,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    );
    return null;
  }
}

// `traycer host available` - explicit registry probe per Flow 6. With neither
// flag it derives RC inclusion from the installed host; `--include-pre-releases`
// and `--no-include-pre-releases` override that in either direction.
export function buildHostAvailableCommand(args: HostAvailableArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const urlInfo = resolveManifestUrl();
    const client = await createDefaultRegistryClient(
      ctx.runtime.environment,
      ctx.progress,
    );
    const manifest = await client.fetchManifest();
    const platformKey = currentHostPlatformKey();
    // Only consulted when the caller stated nothing - an explicit flag must
    // not pay for a disk read, and must not be able to fail on one.
    const installedHostVersion =
      args.includePreReleases === null
        ? await readInstalledHostVersionFailingClosed(
            ctx.runtime.environment,
            ctx,
          )
        : null;
    const resolved = resolveIncludePreReleases({
      override: args.includePreReleases,
      installedHostVersion,
    });
    const listing = buildHostAvailableListing({
      manifest,
      manifestUrl: urlInfo.url,
      platformKey,
      includePreReleases: resolved.includePreReleases,
      includePreReleasesSource: resolved.source,
      cliVersion: resolveCliVersion(process.env),
    });
    return {
      data: {
        manifest: listing.manifest,
        manifestUrl: urlInfo.url,
        platformKey,
        // Both, not one: the resolved inclusion says what the rows were
        // filtered by, and the provenance says why - which is what lets a
        // caller explain an RC-inclusive default without claiming the user
        // saved a preference.
        includePreReleases: resolved.includePreReleases,
        includePreReleasesSource: resolved.source,
      },
      human: listing.human,
      exitCode: 0,
    };
  };
}

export function buildHostAvailableListing(
  args: HostAvailableListingArgs,
): HostAvailableListing {
  const versions = filterHostAvailableVersions(
    args.manifest.versions,
    args.includePreReleases,
  ).map((entry) =>
    projectClientFloor(
      projectPlatformAsset(entry, args.platformKey),
      args.platformKey,
      args.cliVersion,
    ),
  );
  const manifest: HostVersionsManifest = {
    ...args.manifest,
    versions,
  };
  const lines: string[] = [];
  lines.push(`manifest: ${args.manifestUrl}`);
  lines.push(`generatedAt: ${args.manifest.generatedAt}`);
  lines.push(`latest: ${args.manifest.latest}`);
  lines.push(`platform: ${args.platformKey}`);
  lines.push(
    `pre-releases: ${describeIncludePreReleases(args.includePreReleasesSource)}`,
  );
  lines.push("");
  lines.push(
    ...versions.map((entry) => {
      const asset = entry.platforms[args.platformKey];
      const tags: string[] = [];
      if (entry.yanked) tags.push("yanked");
      if (entry.version === args.manifest.latest) tags.push("latest");
      if (entry.deprecationReason !== null) {
        tags.push(`deprecated: ${entry.deprecationReason}`);
      }
      if (asset === undefined) {
        tags.push("no-asset");
      } else if (!asset.available) {
        tags.push(
          `unavailable${asset.unavailableReason !== null ? `: ${asset.unavailableReason}` : ""}`,
        );
      }
      const tagStr = tags.length > 0 ? `  [${tags.join(", ")}]` : "";
      return `  ${entry.version}  released ${entry.releasedAt}${tagStr}`;
    }),
  );
  return {
    manifest,
    human: lines.join("\n"),
  };
}

// The human listing states the provenance too, not just the filter. An RC
// host lists RC rows with no flag passed, and without this line that reads as
// the CLI ignoring its own documented default.
function describeIncludePreReleases(
  source: HostIncludePreReleasesSource,
): string {
  switch (source) {
    case "explicit-include":
      return "included (--include-pre-releases)";
    case "explicit-exclude":
      return "excluded (--no-include-pre-releases)";
    case "installed-rc":
      return "included (following the installed release candidate's line)";
    case "stable-default":
      return "excluded (stable default)";
  }
}

// Emit only the asset for the platform this CLI is running on.
//
// The registry manifest carries one asset per supported platform on every
// version entry - roughly 1.6 KB of a ~2.3 KB entry that no caller on this
// machine can use. Both consumers of this payload already do a single-key
// lookup and discard the rest: Desktop's `projectAvailableSnapshot`
// (ipc/host-management-ipc.ts) and `host-controller.ts`, whose own comment
// documents the expected shape as `versions[].platforms[platformKey]`.
//
// Dropping the other platforms cut the emitted line 3.2x - 70,331 to 21,689
// bytes across 31 versions - with no rendered row changed. That matters
// because this payload is one unsplittable JSON line whose growth is what
// put it past the 64 KiB pipe buffer in the first place (see
// runner/std-write.ts); the flush fixed the truncation, this keeps the line
// from growing into other limits.
//
// Shape-compatible in both directions, which is why this needs no flag or
// version negotiation: an older Desktop only ever looks up the key it
// computed for its own platform and still finds it, and a newer Desktop
// reading an older CLI's output ignores the extra platforms it is handed.
//
// An entry with no asset for this platform keeps an empty `platforms`
// object rather than being dropped: the listing still reports it (tagged
// `no-asset`), and callers distinguish "version exists but not for you"
// from "version does not exist".
function projectPlatformAsset(
  entry: HostVersionEntry,
  platformKey: HostPlatformKey,
): HostVersionEntry {
  const asset = entry.platforms[platformKey];
  return {
    ...entry,
    platforms: asset === undefined ? {} : { [platformKey]: asset },
  };
}

// Project the CLI floor into availability, with the registry client's OWN
// evaluator so the listing and the install path cannot disagree about one
// value: `client.ts` rejects a floored target with HOST_CLIENT_FLOOR_UNMET
// only at download time, AFTER the RPC has answered `accepted` - so a listing
// that ignored the floor advertised installs that could only terminate as
// floor failures. The unreleased-CLI waiver applies here exactly as there (a
// dev build is below every floor by SemVer and is deliberately let through).
function projectClientFloor(
  entry: HostVersionEntry,
  platformKey: HostPlatformKey,
  cliVersion: string,
): HostVersionEntry {
  const asset = entry.platforms[platformKey];
  if (asset === undefined || !asset.available) return entry;
  const floor = evaluateHostClientFloor({
    cliVersion,
    requiredCliVersion: entry.requiredCliVersion,
  });
  if (!isHostClientFloorRefusal(floor)) return entry;
  return {
    ...entry,
    platforms: {
      [platformKey]: {
        ...asset,
        available: false,
        unavailableReason: `Needs Traycer CLI ${floor.requiredCliVersion} or newer (this host's CLI is ${cliVersion}).`,
      },
    },
  };
}

// `isPreReleaseVersion` is the shared catalog predicate rather than a local
// one: Desktop's `HostController` predicts this exact filter to decide whether
// a staged build would still appear in the default listing, and a second copy
// of the rule here is what would eventually purge one.
function filterHostAvailableVersions(
  versions: readonly HostVersionEntry[],
  includePreReleases: boolean,
): readonly HostVersionEntry[] {
  if (includePreReleases) return versions;
  return versions.filter((entry) => !isPreReleaseVersion(entry.version));
}
