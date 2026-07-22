import {
  createDefaultRegistryClient,
  currentHostPlatformKey,
  resolveManifestUrl,
} from "../registry";
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
