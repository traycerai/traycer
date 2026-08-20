import type { Dirent } from "node:fs";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ILogger } from "../logger";

/**
 * TEMPORARY TRANSITION PROVISION for the host's slim-release cutover: park
 * the OUTGOING install's bundled provider CLIs inside the NEW install before
 * the old directory is invalidated.
 *
 * A slim host archive bundles no coding-agent CLIs (the host fetches
 * registry packs at runtime), but the install being replaced carries
 * runnable bytes - its own fat bundle, or a carryover it inherited the same
 * way. Deleting them with the old install would strand every provider behind
 * its first pack download. So the swap moves each pack directory from the
 * old install's `resources/providers/` (and any `resources/legacy-providers/`
 * it was itself carrying) into the new install's
 * `resources/legacy-providers/`, keeping the release-tree layout so each
 * pack's `version.json` sidecar keeps naming the version the bytes are.
 *
 * The host consumes this tree as its resolver's STRICTLY LAST tier and
 * reclaims each pack once its registry copy converges - see
 * `traycer-host/src/domain/providers/legacy-provider-carryover.ts` in the
 * internal repo, the other half of this filesystem contract. The dir name
 * below must match its `LEGACY_CARRYOVER_DIRNAME`.
 *
 * Best-effort by contract: a carryover that cannot be preserved must never
 * fail or roll back an otherwise-good install - the fallback it provides is
 * exactly what a failed update already lived without.
 */
const LEGACY_PROVIDERS_DIRNAME = "legacy-providers";
const PROVIDERS_DIRNAME = "providers";

// The one filesystem failure that means "nothing here" rather than "something
// we could not look at": the path (or a parent component) does not exist
// (ENOENT), or a stray file sits where a directory would be (ENOTDIR).
// EVERY catch in this module routes through this split - a carryover is
// best-effort by contract, but a pack silently lost to EACCES or a transient
// I/O error is a provider its user cannot run, and the invalidation that
// follows destroys the evidence, so the failure must be SAID even though it
// is tolerated.
function isExpectedAbsence(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function isDirectory(path: string, logger: ILogger): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (cause) {
    if (!isExpectedAbsence(cause)) {
      logger.warn("Host install carryover could not stat a path", {
        path,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return false;
  }
}

// Locate `resources/` inside an install directory: at the top level, or one
// level down - the same two-level strategy `resolveHostExecutable` uses for
// the binary, since release archives wrap the runtime in `host-runtime/`.
async function resolveResourcesDir(
  installDir: string,
  logger: ILogger,
): Promise<string | null> {
  const direct = join(installDir, "resources");
  if (await isDirectory(direct, logger)) return direct;
  let entries: Dirent[];
  try {
    entries = await readdir(installDir, { withFileTypes: true });
  } catch (cause) {
    // ENOENT/ENOTDIR mean "no install tree here". Anything else is an
    // install that EXISTS but could not be searched - its packs die with
    // the aside dir without the per-source/per-pack warns below ever seeing
    // them, so this is the only place that can say why (Codex review P2).
    if (!isExpectedAbsence(cause)) {
      logger.warn("Host install carryover could not enumerate an install dir", {
        installDir,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = join(installDir, entry.name, "resources");
    if (await isDirectory(nested, logger)) return nested;
  }
  return null;
}

export async function preserveLegacyProviders(
  oldInstallDir: string,
  newInstallDir: string,
  logger: ILogger,
): Promise<void> {
  try {
    const oldResources = await resolveResourcesDir(oldInstallDir, logger);
    if (oldResources === null) return;
    const newResources = await resolveResourcesDir(newInstallDir, logger);
    if (newResources === null) {
      logger.warn(
        "Host install carryover skipped: new install has no resources dir",
        { oldInstallDir, newInstallDir },
      );
      return;
    }
    const newBundle = join(newResources, PROVIDERS_DIRNAME);
    const dest = join(newResources, LEGACY_PROVIDERS_DIRNAME);
    // `providers` before `legacy-providers`: on a pack both trees carry, the
    // outgoing install's OWN bundle is the newer copy and must win over the
    // residue it inherited from an even older install.
    const sources = [
      join(oldResources, PROVIDERS_DIRNAME),
      join(oldResources, LEGACY_PROVIDERS_DIRNAME),
    ];
    let moved = 0;
    let skipped = 0;
    for (const source of sources) {
      let entries: Dirent[];
      try {
        entries = await readdir(source, { withFileTypes: true });
      } catch (cause) {
        // Any other failure (EACCES, transient I/O) means packs that DO
        // exist were never enumerated and will die with the old install
        // when `invalidateAsideDir` runs - name the source and cause; the
        // per-pack warn below cannot, because no pack was ever seen.
        if (!isExpectedAbsence(cause)) {
          logger.warn(
            "Host install carryover could not enumerate a provider source",
            {
              source,
              message: cause instanceof Error ? cause.message : String(cause),
            },
          );
        }
        continue;
      }
      for (const entry of entries) {
        // Files at the providers root (PROVIDERS.json, README.md) are the
        // OLD build's metadata - the version truth travels per-pack in each
        // directory's version.json, so root files stay behind and die with
        // the old install.
        if (!entry.isDirectory()) continue;
        // A pack the new install bundles itself (ripgrep) needs no carryover,
        // and one an earlier source already placed is the newer copy.
        if (await isDirectory(join(newBundle, entry.name), logger)) continue;
        if (await isDirectory(join(dest, entry.name), logger)) continue;
        try {
          await mkdir(dest, { recursive: true });
          // Same volume (both under the host home), so this is a rename, not
          // a multi-GB copy. A pack that cannot move (a lingering handle on
          // Windows) is skipped and dies with the old install - same outcome
          // that pack had before this provision existed.
          await rename(join(source, entry.name), join(dest, entry.name));
          moved += 1;
        } catch (cause) {
          skipped += 1;
          // Name the pack and the cause: until its registry download lands,
          // a skipped pack is a provider this user cannot run, and the
          // summary count below cannot say which one.
          logger.warn("Host install carryover could not move a provider pack", {
            pack: entry.name,
            source,
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    }
    if (moved > 0 || skipped > 0) {
      logger.info("Host install carried legacy provider packs forward", {
        oldInstallDir,
        moved,
        skipped,
      });
    }
  } catch (cause) {
    logger.warn("Host install carryover failed; continuing", {
      oldInstallDir,
      newInstallDir,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
