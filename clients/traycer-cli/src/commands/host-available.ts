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
import type {
  HostPlatformKey,
  HostVersionEntry,
  HostVersionsManifest,
} from "../registry";
import type { CommandFn, CommandResult } from "../runner/runner";

interface HostAvailableArgs {
  readonly includePreReleases: boolean;
}

interface HostAvailableListingArgs {
  readonly manifest: HostVersionsManifest;
  readonly manifestUrl: string;
  readonly platformKey: HostPlatformKey;
  readonly includePreReleases: boolean;
  /** THIS CLI's version - the floor is about the runner, not the archive. */
  readonly cliVersion: string;
}

interface HostAvailableListing {
  readonly manifest: HostVersionsManifest;
  readonly human: string;
}

// `traycer host available` - explicit registry probe per Flow 6. By default it
// lists stable host versions only; pass --include-pre-releases to inspect RCs.
export function buildHostAvailableCommand(args: HostAvailableArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const urlInfo = resolveManifestUrl();
    const client = await createDefaultRegistryClient(
      ctx.runtime.environment,
      ctx.progress,
    );
    const manifest = await client.fetchManifest();
    const platformKey = currentHostPlatformKey();
    const listing = buildHostAvailableListing({
      manifest,
      manifestUrl: urlInfo.url,
      platformKey,
      includePreReleases: args.includePreReleases,
      cliVersion: resolveCliVersion(process.env),
    });
    return {
      data: {
        manifest: listing.manifest,
        manifestUrl: urlInfo.url,
        platformKey,
        includePreReleases: args.includePreReleases,
      },
      human: listing.human,
      exitCode: 0,
    };
  };
}

export const hostAvailableCommand: CommandFn = buildHostAvailableCommand({
  includePreReleases: false,
});

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

function filterHostAvailableVersions(
  versions: readonly HostVersionEntry[],
  includePreReleases: boolean,
): readonly HostVersionEntry[] {
  if (includePreReleases) return versions;
  return versions.filter((entry) => !isPreReleaseVersion(entry.version));
}

function isPreReleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version);
}
