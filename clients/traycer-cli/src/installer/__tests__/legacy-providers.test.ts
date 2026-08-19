import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { noopLogger } from "../../logger";
import type { ILogger, LogFields } from "../../logger";
import { preserveLegacyProviders } from "../legacy-providers";

/**
 * `preserveLegacyProviders` - the OSS half of the slim-release carryover
 * contract with `traycer-host/src/domain/providers/legacy-provider-carryover.ts`
 * in the internal repo. tmpdir-based, real filesystem: the point of the
 * function is what actually lands on disk after the swap.
 */

let sandboxRoot: string;

beforeEach(() => {
  sandboxRoot = mkdtempSync(join(tmpdir(), "legacy-providers-"));
});

afterEach(() => {
  rmSync(sandboxRoot, { recursive: true, force: true });
});

const PLATFORM_ARCH = "darwin-arm64";

// Root ignores directory permission bits, so the EACCES-enumerate case below
// would read the chmod-0o000 dir cleanly and assert nothing.
const runsAsRoot =
  typeof process.getuid === "function" && process.getuid() === 0;

// The nested `host-runtime/resources/...` shape a release archive extracts
// into - `resolveResourcesDir`'s "one level down" branch.
function wrappedResources(installDir: string): string {
  return join(installDir, "host-runtime", "resources");
}

// The flat `resources/...` shape - `resolveResourcesDir`'s direct-hit branch.
function topLevelResources(installDir: string): string {
  return join(installDir, "resources");
}

function writePack(
  resourcesDir: string,
  bundleDirname: "providers" | "legacy-providers",
  pack: string,
  version: string,
): void {
  const packDir = join(resourcesDir, bundleDirname, pack, PLATFORM_ARCH);
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, "version.json"), JSON.stringify({ version }));
  writeFileSync(join(packDir, pack), "binary-bytes");
}

function writeRootFile(
  resourcesDir: string,
  bundleDirname: "providers" | "legacy-providers",
  name: string,
  content: string,
): void {
  const dir = join(resourcesDir, bundleDirname);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}

function readCarriedVersion(resourcesDir: string, pack: string): unknown {
  return JSON.parse(
    readFileSync(
      join(
        resourcesDir,
        "legacy-providers",
        pack,
        PLATFORM_ARCH,
        "version.json",
      ),
      "utf8",
    ),
  );
}

function capturingLogger(): {
  readonly logger: ILogger;
  readonly warnings: readonly { message: string; fields: LogFields }[];
} {
  const warnings: { message: string; fields: LogFields }[] = [];
  const logger: ILogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message, fields) => {
      warnings.push({ message, fields });
    },
    error: () => undefined,
  };
  return { logger, warnings };
}

describe("preserveLegacyProviders", () => {
  it("carries a pack the new install does not bundle, skips one it does, and leaves root metadata files behind", async () => {
    const oldInstall = join(sandboxRoot, "old-install");
    const newInstall = join(sandboxRoot, "new-install");
    const oldResources = wrappedResources(oldInstall);
    const newResources = wrappedResources(newInstall);

    writePack(oldResources, "providers", "codex", "1.2.3");
    writePack(oldResources, "providers", "ripgrep", "13.0.0");
    writeRootFile(oldResources, "providers", "PROVIDERS.json", "{}");
    writePack(newResources, "providers", "ripgrep", "14.0.0");

    // Captured BEFORE the move: a same-inode comparison after is what proves
    // this is a rename (the same bytes on disk, just re-linked), not a copy
    // that happens to leave the source behind. `ino` is not a meaningful
    // identity on win32 (NTFS via Node reports it inconsistently across
    // rename), so that half of the assertion is skipped there.
    const originalIno =
      platform() === "win32"
        ? null
        : statSync(
            join(oldResources, "providers", "codex", PLATFORM_ARCH, "codex"),
          ).ino;

    await preserveLegacyProviders(oldInstall, newInstall, noopLogger);

    expect(
      existsSync(
        join(newResources, "legacy-providers", "codex", PLATFORM_ARCH),
      ),
    ).toBe(true);
    expect(readCarriedVersion(newResources, "codex")).toEqual({
      version: "1.2.3",
    });
    expect(
      existsSync(
        join(newResources, "legacy-providers", "codex", PLATFORM_ARCH, "codex"),
      ),
    ).toBe(true);

    // ripgrep is bundled by the new install itself - never carried.
    expect(existsSync(join(newResources, "legacy-providers", "ripgrep"))).toBe(
      false,
    );

    // Root-level metadata dies with the old install; only per-pack dirs move.
    expect(
      existsSync(join(newResources, "legacy-providers", "PROVIDERS.json")),
    ).toBe(false);

    // The move is a rename, not a copy - the old pack dir is gone afterward.
    expect(existsSync(join(oldResources, "providers", "codex"))).toBe(false);

    if (originalIno !== null) {
      const movedIno = statSync(
        join(newResources, "legacy-providers", "codex", PLATFORM_ARCH, "codex"),
      ).ino;
      expect(movedIno).toBe(originalIno);
    }
  });

  it("chains a carryover forward: packs the old install itself inherited (its own legacy-providers) ride along too", async () => {
    const oldInstall = join(sandboxRoot, "old-install");
    const newInstall = join(sandboxRoot, "new-install");
    const oldResources = wrappedResources(oldInstall);
    const newResources = wrappedResources(newInstall);

    writePack(oldResources, "providers", "ripgrep", "13.0.0");
    writePack(oldResources, "legacy-providers", "codex", "1.2.3");
    writePack(oldResources, "legacy-providers", "opencode", "0.9.0");
    writePack(newResources, "providers", "ripgrep", "14.0.0");

    await preserveLegacyProviders(oldInstall, newInstall, noopLogger);

    expect(
      existsSync(
        join(newResources, "legacy-providers", "codex", PLATFORM_ARCH),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(newResources, "legacy-providers", "opencode", PLATFORM_ARCH),
      ),
    ).toBe(true);
    expect(existsSync(join(newResources, "legacy-providers", "ripgrep"))).toBe(
      false,
    );
  });

  it("on a collision, the outgoing install's OWN bundle wins over the carryover it inherited", async () => {
    const oldInstall = join(sandboxRoot, "old-install");
    const newInstall = join(sandboxRoot, "new-install");
    const oldResources = wrappedResources(oldInstall);
    const newResources = wrappedResources(newInstall);

    // Both trees carry a "codex" pack; `providers` is the outgoing install's
    // own bundle and must be the one that survives the merge.
    writePack(oldResources, "providers", "codex", "newer");
    writePack(oldResources, "legacy-providers", "codex", "older");
    // The new install needs SOME resources dir for `resolveResourcesDir` to
    // find - an unrelated pack, so this stays a pure collision test on codex.
    writePack(newResources, "providers", "ripgrep", "14.0.0");

    await preserveLegacyProviders(oldInstall, newInstall, noopLogger);

    expect(readCarriedVersion(newResources, "codex")).toEqual({
      version: "newer",
    });
  });

  it("is a no-op that never throws when the old install has no resources dir at all", async () => {
    const oldInstall = join(sandboxRoot, "old-install-bare");
    const newInstall = join(sandboxRoot, "new-install");
    mkdirSync(oldInstall, { recursive: true });
    const newResources = wrappedResources(newInstall);
    writePack(newResources, "providers", "ripgrep", "14.0.0");

    const { logger, warnings } = capturingLogger();
    await expect(
      preserveLegacyProviders(oldInstall, newInstall, logger),
    ).resolves.toBeUndefined();

    // A genuinely absent source (ENOENT) is `isExpectedAbsence` territory -
    // silent, not warned. This already pins that: zero warn calls.
    expect(warnings).toEqual([]);
    expect(existsSync(join(newResources, "legacy-providers"))).toBe(false);
  });

  it("resolves a top-level resources/ dir too, not only one nested under host-runtime/", async () => {
    const oldInstall = join(sandboxRoot, "old-install");
    const newInstall = join(sandboxRoot, "new-install");
    const oldResources = topLevelResources(oldInstall);
    const newResources = topLevelResources(newInstall);

    writePack(oldResources, "providers", "codex", "1.2.3");
    writePack(newResources, "providers", "ripgrep", "14.0.0");

    await preserveLegacyProviders(oldInstall, newInstall, noopLogger);

    expect(
      existsSync(
        join(newResources, "legacy-providers", "codex", PLATFORM_ARCH),
      ),
    ).toBe(true);
  });

  it("warns with the pack's name and keeps moving the rest when one pack's move fails", async () => {
    const oldInstall = join(sandboxRoot, "old-install");
    const newInstall = join(sandboxRoot, "new-install");
    const oldResources = wrappedResources(oldInstall);
    const newResources = wrappedResources(newInstall);

    writePack(oldResources, "providers", "codex", "1.2.3");
    writePack(oldResources, "providers", "opencode", "0.9.0");
    writePack(newResources, "providers", "ripgrep", "14.0.0");

    // Pre-seed the destination slot a "codex" move would land in with a FILE,
    // not a directory: `rename()` of a directory onto an existing
    // non-directory path fails (ENOTDIR/EISDIR depending on platform), which
    // is the one failure this best-effort loop must survive without
    // aborting the packs after it.
    const dest = join(newResources, "legacy-providers");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "codex"), "not a directory");

    const { logger, warnings } = capturingLogger();
    await expect(
      preserveLegacyProviders(oldInstall, newInstall, logger),
    ).resolves.toBeUndefined();

    expect(warnings.length).toBe(1);
    expect(warnings[0]?.message).toBe(
      "Host install carryover could not move a provider pack",
    );
    expect(warnings[0]?.fields.pack).toBe("codex");

    // codex's move failed - its source dir is untouched, and the collided
    // destination slot is still the plain file it was.
    expect(
      existsSync(join(oldResources, "providers", "codex", PLATFORM_ARCH)),
    ).toBe(true);
    expect(existsSync(join(dest, "codex", PLATFORM_ARCH))).toBe(false);

    // opencode has no collision and moves fine despite codex's failure.
    expect(
      existsSync(
        join(newResources, "legacy-providers", "opencode", PLATFORM_ARCH),
      ),
    ).toBe(true);
  });

  it.skipIf(platform() === "win32" || runsAsRoot)(
    "warns with the source path (not silently skipping) when a source dir exists but cannot be enumerated, and still processes the OTHER source",
    async () => {
      const oldInstall = join(sandboxRoot, "old-install");
      const newInstall = join(sandboxRoot, "new-install");
      const oldResources = wrappedResources(oldInstall);
      const newResources = wrappedResources(newInstall);

      const oldProvidersDir = join(oldResources, "providers");
      mkdirSync(oldProvidersDir, { recursive: true });
      // Seed the OTHER source ("legacy-providers") so this proves it is
      // still processed despite "providers" being unreadable.
      writePack(oldResources, "legacy-providers", "opencode", "0.9.0");
      writePack(newResources, "providers", "ripgrep", "14.0.0");

      // EACCES, not ENOENT/ENOTDIR: the dir genuinely exists but this
      // process cannot list it - the one case `isExpectedAbsence` must NOT
      // swallow silently.
      chmodSync(oldProvidersDir, 0o000);

      const { logger, warnings } = capturingLogger();
      try {
        await expect(
          preserveLegacyProviders(oldInstall, newInstall, logger),
        ).resolves.toBeUndefined();

        expect(warnings.length).toBe(1);
        expect(warnings[0]?.message).toBe(
          "Host install carryover could not enumerate a provider source",
        );
        expect(warnings[0]?.fields.source).toBe(oldProvidersDir);

        // The other source is still processed despite the first one's
        // enumeration failure - one bad source must not abort the loop.
        expect(
          existsSync(
            join(newResources, "legacy-providers", "opencode", PLATFORM_ARCH),
          ),
        ).toBe(true);
      } finally {
        // Restore permissions so afterEach's rmSync(sandboxRoot) can actually
        // enumerate and delete it.
        chmodSync(oldProvidersDir, 0o755);
      }
    },
  );

  it.skipIf(platform() === "win32" || runsAsRoot)(
    "warns 'could not enumerate an install dir' when the OLD INSTALL DIR itself cannot be listed, and resolves without throwing",
    async () => {
      const oldInstall = join(sandboxRoot, "old-install-locked");
      const newInstall = join(sandboxRoot, "new-install");
      // A real nested layout first, so this models an install that GENUINELY
      // has packs - not an empty stub - before locking the dir down.
      writePack(wrappedResources(oldInstall), "providers", "codex", "1.2.3");
      const newResources = wrappedResources(newInstall);
      writePack(newResources, "providers", "ripgrep", "14.0.0");

      // EACCES on the install dir itself: neither `stat` on a path inside
      // it (the direct "<install>/resources" probe) nor `readdir` on it
      // directly can succeed - both fail EACCES, not ENOENT/ENOTDIR, so
      // BOTH must be warned rather than silently swallowed.
      chmodSync(oldInstall, 0o000);

      const { logger, warnings } = capturingLogger();
      try {
        await expect(
          preserveLegacyProviders(oldInstall, newInstall, logger),
        ).resolves.toBeUndefined();

        expect(warnings.length).toBe(2);

        const enumerateWarning = warnings.find(
          (w) =>
            w.message ===
            "Host install carryover could not enumerate an install dir",
        );
        expect(enumerateWarning).toBeDefined();
        expect(enumerateWarning?.fields.installDir).toBe(oldInstall);

        // The direct "<install>/resources" stat probe fails through the
        // same unreadable parent - also EACCES, also warned.
        const statWarning = warnings.find(
          (w) => w.message === "Host install carryover could not stat a path",
        );
        expect(statWarning).toBeDefined();

        // Nothing from the unreachable old install was carried.
        expect(existsSync(join(newResources, "legacy-providers"))).toBe(false);
      } finally {
        // Restore permissions so afterEach's rmSync(sandboxRoot) can
        // actually enumerate and delete it.
        chmodSync(oldInstall, 0o755);
      }
    },
  );
});
