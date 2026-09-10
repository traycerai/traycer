/**
 * The host archive's `version.json` sidecar: what a tree SAYS about itself.
 *
 * Its own module, and deliberately not part of `install.ts`, because of who
 * needs it. The store-format floor asks these questions about the tree it is
 * about to swap in AND about the tree already installed, and the second caller
 * (`host/installed-store-formats.ts`) has nothing to do with installing
 * anything. Reaching into `install.ts` for it dragged that whole module - and
 * every mock a suite puts over it - into the floor's path: `ensure.test.ts`
 * and `provision.test.ts` mock `../../installer/install` wholesale, so a
 * reader living there made the floor explode inside suites that had no
 * business knowing it existed.
 *
 * Two readers over one file rather than one combined read, because their
 * failure policies genuinely differ: the runtime version is read at STAGE time
 * and simply degrades to "no stamp", while the store formats are read at the
 * COMMIT gate and a present-but-malformed declaration is worth a warning. Both
 * still refuse to invent a value.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  declaredStoreFormatsFromSidecar,
  type HostStoreFormats,
} from "@traycer/protocol/host/store-formats";
import type { ILogger } from "../logger";
import type { Environment } from "../runner/environment";

// Reads the `version.json` sidecar the host build emits into the archive
// root (traycer-host/scripts/build-host-sea.cjs, writeRuntimeVersionJson).
// Absent or malformed (archives predating the sidecar, hand-rolled trees)
// degrades to null - the record then simply carries no runtime stamp.
export async function readExtractedRuntimeVersion(
  extractedDir: string,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(join(extractedDir, "version.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      const version = (parsed as Record<string, unknown>).version;
      if (typeof version === "string" && version.length > 0) return version;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * The store formats an ARCHIVE declares about itself, from the same
 * `version.json` sidecar that carries its runtime version.
 *
 * This is the third source of format knowledge, and the only one that can
 * speak for a build which is not a release. A local desktop install bundles a
 * host stamped `<target>.<epochMs>.<sha>`: the registry manifest has no entry
 * for it and the fixed table has no line for it, so before archives declared
 * their own formats the floor could only stand aside. With a declaration such
 * a build is judged exactly like a published one.
 *
 * NEVER THROWS, and malformed is `null` rather than a refusal - the one place
 * this module's fail-closed instinct is deliberately relaxed. An undeclared
 * archive is already a supported state (every archive built before the writer
 * landed is one), so a typo in the sidecar must land the caller in that same
 * state and not brick a local convergence. What it must not do is invent a
 * format, which is why every arm returns `null` instead of a default.
 *
 * Validated by the same rule as the manifest's `parseNullableStoreFormats`:
 * `chatDb` must be a positive safe integer.
 */
export async function readExtractedStoreFormats(
  extractedDir: string,
  environment: Environment,
  logger: ILogger,
): Promise<HostStoreFormats | null> {
  let raw: string;
  try {
    raw = await readFile(join(extractedDir, "version.json"), "utf8");
  } catch {
    // Absent sidecar: an archive older than the writer, or a hand-rolled tree.
    // Not worth a log line - it is the ordinary state of every archive built
    // before this field existed.
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // The interpretation is the protocol's, shared with the host's own read of
  // the sidecar it runs from (`host.status`'s install report), so the two
  // processes cannot accept different shapes.
  const reading = declaredStoreFormatsFromSidecar(parsed);
  if (reading.kind === "malformed") {
    // Present and unusable IS worth saying out loud: the archive tried to
    // declare something and this build could not read it, which is a packaging
    // bug rather than an old archive.
    logger.warn(
      "Host archive declared an unreadable storeFormats; treating it as undeclared",
      { environment, extractedDir },
    );
    return null;
  }
  return reading.kind === "declared" ? reading.formats : null;
}
