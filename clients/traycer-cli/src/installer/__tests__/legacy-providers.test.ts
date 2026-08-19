import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
});
