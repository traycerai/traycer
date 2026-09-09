/**
 * Which data roots the chat-store survey has to walk.
 *
 * ## Why this is not just `hostHomeDir(environment)`
 *
 * That is the root the CLI hands the host as `--host-data-dir`, and on a dev
 * desktop it resolves a RUN SLOT (`host/dev-runs/<slot>`). The host does not
 * necessarily keep its chat stores there: `identityHomeDir()` resolves to
 * `devIdentityHomeOverride ?? <host home>`, and the override is installed in
 * the host process by the dev identity-pool walk, rooting the stores under
 * `host/dev/identities/<identity>` instead. A slot with no `epic-state` is
 * then read as "no stores on this machine" and clears a downgrade that should
 * have been refused - while the real format-9 files sit one directory over.
 *
 * ## The rule, and why it is the repo's existing doctrine
 *
 * `store/paths.ts` already settled this shape for a sibling probe, in
 * `hostDevIdentityPoolRoot`'s docblock: *"Read for EXISTENCE only. What it can
 * establish is narrow and negative: with no pool on this machine, no host here
 * can have an overridden identity home, so the default one is the only one and
 * silence is honest."* This applies the same reading:
 *
 * - **production** is exactly one root. The pool lives under `host/dev`, so it
 *   cannot hold production stores, and the shipped path stays a single-root
 *   walk that behaves byte-for-byte as it did before this existed.
 * - **dev** covers the slot, the unslotted dev home, and every identity in the
 *   pool WHEN THE POOL EXISTS. No pool means no host here can have an
 *   overridden identity home, so the roots collapse back to the first two.
 *
 * ## Cover-all, not indeterminate
 *
 * Which identity a running host acquired is knowledge that exists only inside
 * that process, so the CLI cannot attribute one. It surveys all of them. That
 * over-refuses only when an identity OTHER than the one the next host acquires
 * holds a newer store - and on a dev machine those are written by the same
 * builds - whereas returning "indeterminate" whenever a pool exists would
 * refuse every dev downgrade, including on machines whose stores are all fine,
 * with no flag in the dev loop to get past it. Over-refusal is correctable;
 * under-refusal is the crash loop this whole gate exists to prevent.
 */
import { lstat, readdir } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";
import {
  hostDevHomeDir,
  hostDevIdentityPoolRoot,
  hostHomeDir,
} from "../store/paths";
import type { Environment } from "../runner/environment";

export interface ChatStoreSurveyRoot {
  /** A host DATA root - the directory that holds `epic-state/`. */
  readonly path: string;
  /**
   * Short name for this root, used to qualify epic ids when more than one
   * root is surveyed. Two roots can hold the same epic id, and a refusal
   * reading "epic-a at format 9; epic-a at format 8" helps nobody.
   */
  readonly label: string;
}

export interface ChatStoreSurveyRoots {
  readonly roots: readonly ChatStoreSurveyRoot[];
  /**
   * True when a candidate SOURCE could not be enumerated - today, a pool root
   * that exists but cannot be read.
   *
   * Carried rather than thrown, and never collapsed into "no roots": an
   * unreadable pool is the one state where the survey knows it may be blind to
   * stores that exist, and the caller has to turn that into a failure entry
   * rather than into silence. Exactly the rule the `epic-state` readdir
   * already follows.
   */
  readonly enumerationFailed: boolean;
}

/** The label for the root the CLI hands the host as `--host-data-dir`. */
const PRIMARY_ROOT_LABEL = "host";
const DEV_HOME_ROOT_LABEL = "dev";

/**
 * Resolve every root a target build could find chat stores in.
 *
 * Existence-only reads: a missing pool root is the ordinary state and yields
 * no extra roots. Ordering is stable (primary first) so a refusal lists the
 * machine's own root before any pooled identity.
 *
 * Every pool entry is `lstat`ed rather than trusted to be a directory, and the
 * three non-directory answers are deliberately different: a regular file is
 * skipped (it never was an identity home), a vanished entry is skipped
 * (nothing there to be blind to), and a SYMLINK sets `enumerationFailed`
 * (following it could widen the survey, ignoring it could hide a real home,
 * and the resolver cannot tell which).
 */
export async function resolveChatStoreSurveyRoots(
  environment: Environment,
): Promise<ChatStoreSurveyRoots> {
  const primary: ChatStoreSurveyRoot = {
    path: hostHomeDir(environment),
    label: PRIMARY_ROOT_LABEL,
  };
  if (environment !== "dev") {
    return { roots: [primary], enumerationFailed: false };
  }
  const roots: ChatStoreSurveyRoot[] = [primary];
  // The unslotted dev home, which a dev host uses when nothing handed it a
  // `--host-data-dir`. Skipped when the environment is not slotted, because
  // `hostHomeDir("dev")` is then already this same directory.
  const devHome = hostDevHomeDir();
  if (devHome !== primary.path) {
    roots.push({ path: devHome, label: DEV_HOME_ROOT_LABEL });
  }
  const poolRoot = hostDevIdentityPoolRoot();
  let identities: readonly string[];
  try {
    identities = await readdir(poolRoot);
  } catch (error: unknown) {
    // Absent is the ordinary answer and the honest one: no pool means no host
    // here can have an overridden identity home. Anything else is a source
    // this resolver could not read, which the caller must surface.
    if (isNotFound(error)) return { roots, enumerationFailed: false };
    return { roots, enumerationFailed: true };
  }
  let enumerationFailed = false;
  for (const identity of [...identities].sort()) {
    const path = join(poolRoot, identity);
    let entry: Stats;
    try {
      entry = await lstat(path);
    } catch (error: unknown) {
      // Vanished between the readdir and this lstat - a pool entry being
      // reclaimed while we walk. Nothing is there, so there is nothing to be
      // blind to.
      if (isNotFound(error)) continue;
      enumerationFailed = true;
      continue;
    }
    // A LINK is not silently skipped, and this is the one entry class where
    // skipping would be wrong in both directions: followed, it could point the
    // survey at a tree that is not an identity home; ignored, it could hide
    // one that is. The survey cannot say which, and "cannot say" is exactly
    // what `enumerationFailed` means. Same rule as a linked epic directory,
    // for the same reason.
    if (entry.isSymbolicLink()) {
      enumerationFailed = true;
      continue;
    }
    // A stray regular file - `.DS_Store`, a lockfile, an editor swapfile - is
    // NOT an identity home and never was. Taking it as a root made
    // `listEpicDirs` fail with ENOTDIR, which the survey correctly reports as
    // a root it could not enumerate, so a single Finder visit to this
    // directory refused every downgrade on an otherwise healthy dev machine.
    if (!entry.isDirectory()) continue;
    roots.push({ path, label: identity });
  }
  return { roots, enumerationFailed };
}

/**
 * The single-root case, for a caller that already holds the one data root it
 * means - the floor's own suites, which state a temp directory rather than
 * inheriting the developer's `~/.traycer`.
 */
export function singleChatStoreSurveyRoot(path: string): ChatStoreSurveyRoots {
  return {
    roots: [{ path, label: PRIMARY_ROOT_LABEL }],
    enumerationFailed: false,
  };
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "ENOENT";
}
