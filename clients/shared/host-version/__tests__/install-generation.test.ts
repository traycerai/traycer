import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeInstallGeneration } from "../install-generation";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

/**
 * Every production caller of `encodeInstallGeneration`, and how it passes its
 * argument.
 *
 * `migrated` sites hand the RECORD through whole. `pendingLiteral` sites still
 * rebuild the four-field object by hand and are listed BY NAME with the change
 * that owns them, so the list is a debt register rather than a blanket
 * exemption: a site that appears here without being written down fails the pin,
 * which is the case that matters - a NEW hand-built literal.
 */
const MIGRATED_CALLERS: readonly string[] = [
  "clients/traycer-cli/src/installer/apply.ts",
  "clients/traycer-cli/src/installer/install.ts",
  "clients/traycer-cli/src/installer/download-stage.ts",
  // Already passing an identity whole before this change, and not
  // `bafc226ec`'s. Found by the discovery scan below, which is the point of
  // having one: the first version of these lists was hand-written and this
  // caller was in neither (cold review B).
  "clients/traycer-cli/src/host/update-executor.ts",
];

const PENDING_LITERAL_CALLERS: readonly string[] = [
  // Owned by `bafc226ec` on the Q13/Q3/Q9 line, which migrates all four in one
  // change. Deliberately NOT migrated here: both branches edit these files, and
  // duplicating the same edit buys a merge conflict for no behaviour. Delete
  // these entries when that change lands and the pin tightens by itself.
  "clients/traycer-cli/src/host/provision.ts",
  "clients/traycer-cli/src/host/attested-install-runtime.ts",
  "clients/traycer-cli/src/host/stamp-runtime.ts",
  "clients/traycer-cli/src/host/update-run.ts",
  // Desktop main's own capture, out of this package's scope.
  "clients/desktop/src/electron-main/host/host-state.ts",
];

function sourceOf(repoRelativePath: string): string {
  return readFileSync(join(REPO_ROOT, repoRelativePath), "utf8");
}

/**
 * Every production file that calls `encodeInstallGeneration`, DISCOVERED.
 *
 * The lists above are claims about the tree; this reads the tree. Without it
 * the register can only check files it was already told about, so a brand-new
 * caller - the case the pin exists for - is invisible rather than red. Cold
 * review B proved that on this branch: `host/update-executor.ts` called the
 * encoder from neither list and nothing objected, correct today and unpinned
 * against tomorrow.
 *
 * `git grep -l` rather than a directory walk: it already respects
 * `.gitignore`, so build output, `node_modules` and scratch files cannot join
 * the register by being written next to source. `--untracked` is not optional
 * here - without it a caller added in a BRAND-NEW file is invisible until
 * someone stages it, which is exactly the window in which the pin is supposed
 * to speak.
 */
function discoveredCallers(): readonly string[] {
  const out = execFileSync(
    "git",
    ["grep", "-l", "--untracked", "encodeInstallGeneration(", "--", "clients"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  return (
    out
      .split("\n")
      .filter((line) => line.length > 0)
      .filter((line) => !line.includes("__tests__"))
      // The encoder's own module defines it; it does not call it.
      .filter((line) => !line.endsWith("host-version/install-generation.ts"))
      .sort()
  );
}

/**
 * The literal shape this pin exists to keep out: an inline object rebuilding
 * the identity field by field at the call site.
 */
const HAND_BUILT_LITERAL = /encodeInstallGeneration\(\s*\{/;

describe("encodeInstallGeneration", () => {
  it("uses the installId when present, ignoring the legacy fields entirely", () => {
    const generation = encodeInstallGeneration({
      installId: "3f5b6c1a-1111-4c9a-9999-abcdefabcdef",
      installedAt: "2026-01-01T00:00:00.000Z",
      archiveSha256: "a".repeat(64),
      version: "1.2.3",
    });
    expect(generation).toBe("id:3f5b6c1a-1111-4c9a-9999-abcdefabcdef");
  });

  it("falls back to the legacy tuple when installId is null", () => {
    const generation = encodeInstallGeneration({
      installId: null,
      installedAt: "2026-01-01T00:00:00.000Z",
      archiveSha256: "a".repeat(64),
      version: "1.2.3",
    });
    expect(generation).toBe(
      `legacy:2026-01-01T00:00:00.000Z|${"a".repeat(64)}|1.2.3`,
    );
  });

  it("encodes a null archiveSha256 as an empty legacy-tuple segment", () => {
    const generation = encodeInstallGeneration({
      installId: null,
      installedAt: "2026-01-01T00:00:00.000Z",
      archiveSha256: null,
      version: "local-host.tar.gz-2026-01-01T00-00-00-000Z",
    });
    expect(generation).toBe(
      "legacy:2026-01-01T00:00:00.000Z||local-host.tar.gz-2026-01-01T00-00-00-000Z",
    );
  });

  it("is stable and deterministic for identical inputs", () => {
    const identity = {
      installId: null,
      installedAt: "2026-02-02T00:00:00.000Z",
      archiveSha256: "b".repeat(64),
      version: "2.0.0",
    };
    expect(encodeInstallGeneration(identity)).toBe(
      encodeInstallGeneration({ ...identity }),
    );
  });

  it("distinguishes two different legacy installs with the same version but different installedAt", () => {
    const first = encodeInstallGeneration({
      installId: null,
      installedAt: "2026-01-01T00:00:00.000Z",
      archiveSha256: "c".repeat(64),
      version: "1.0.0",
    });
    const second = encodeInstallGeneration({
      installId: null,
      installedAt: "2026-01-02T00:00:00.000Z",
      archiveSha256: "c".repeat(64),
      version: "1.0.0",
    });
    expect(first).not.toBe(second);
  });

  it("never collides an installId-shaped fingerprint with a legacy-tuple one", () => {
    // Deliberately construct a legacy tuple whose fields, if concatenated
    // without the tag prefix, could coincidentally resemble an installId
    // fingerprint - the `id:`/`legacy:` prefixes keep the two encodings in
    // disjoint namespaces regardless of field content.
    const legacy = encodeInstallGeneration({
      installId: null,
      installedAt: "id:not-actually-an-installId",
      archiveSha256: null,
      version: "1.0.0",
    });
    const minted = encodeInstallGeneration({
      installId: "not-actually-an-installId",
      installedAt: "2026-01-01T00:00:00.000Z",
      archiveSha256: null,
      version: "1.0.0",
    });
    expect(legacy).not.toBe(minted);
  });
});

/**
 * The construction rule, pinned at SOURCE level (cold review B, F1).
 *
 * `encodeInstallGeneration`'s output is compared byte-for-byte across modules
 * that never see each other's code: the claim baseline a park records, the
 * value `host start`'s relaunch admission recomputes under the attempt lock,
 * the CAS in `host stamp-runtime`. Byte-identical construction is therefore the
 * whole contract, and a per-site field mapping makes that contract a convention
 * every future caller has to remember - one that drifts silently, because a
 * forgotten field produces a perfectly valid string that simply never matches.
 *
 * The unit tests above cannot see this: they pass whatever they are handed. The
 * defect lives in the CALL SITES, so the pin has to read them.
 */
describe("encodeInstallGeneration call sites", () => {
  it.each(MIGRATED_CALLERS)("%s passes the record, not a literal", (path) => {
    const source = sourceOf(path);
    expect(source).toContain("encodeInstallGeneration(");
    expect(source).not.toMatch(HAND_BUILT_LITERAL);
  });

  it("knows about every caller in the tree", () => {
    // The discovery step, and the one assertion that can fail for a caller
    // nobody wrote down. Without it the two directional tests below only ever
    // read files the lists already name, so the register's headline claim -
    // that a NEW hand-built literal reddens - was false as first written.
    const known = [...MIGRATED_CALLERS, ...PENDING_LITERAL_CALLERS].sort();
    expect(discoveredCallers()).toEqual(known);
  });

  it("names every remaining hand-built literal, and no others", () => {
    // Discovered, not assumed: the scan is over the union of both lists, so a
    // site that drops its literal without leaving `PENDING_LITERAL_CALLERS`
    // reddens too - the register cannot rot in the quiet direction either.
    const stillLiteral = [...MIGRATED_CALLERS, ...PENDING_LITERAL_CALLERS]
      .filter((path) => HAND_BUILT_LITERAL.test(sourceOf(path)))
      .sort();
    expect(stillLiteral).toEqual([...PENDING_LITERAL_CALLERS].sort());
  });

  it("every migrated site is inside a package this pin is allowed to read", () => {
    // A guard on the guard: `REPO_ROOT` is computed by climbing four levels
    // from this file, so a move of the test would silently start reading some
    // other tree - and `readFileSync` on a path that resolves outside the repo
    // would throw here rather than pass vacuously.
    for (const path of [...MIGRATED_CALLERS, ...PENDING_LITERAL_CALLERS]) {
      const resolved = join(REPO_ROOT, path);
      expect(relative(REPO_ROOT, resolved)).toBe(path);
      expect(() => readFileSync(resolved, "utf8")).not.toThrow();
    }
  });
});
