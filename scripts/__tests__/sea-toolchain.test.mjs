import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Verification of the official Node tarball the SEA build downloads when the
// build machine's own `node` has no SEA fuse. Ported from the internal
// monorepo together with the check itself: this repo's copy of
// `sea-toolchain.cjs` had the same `provisionOfficialNode` with NO
// verification at all - it downloaded, extracted, and checked only that the
// result carried the fuse sentinel, which any substituted tarball satisfies.
//
// The second block is the one that matters. Helper tests over the parser and
// the comparison stay green even if `provisionOfficialNode` stops calling
// them, so the wiring block drives the real function in a vm over a synthetic
// filesystem, and every case is gated by an ablation that must redden it.

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const TOOLCHAIN_PATH = path.join(
  REPO_ROOT,
  "scripts",
  "native-packaging",
  "sea-toolchain.cjs",
);

describe("official Node tarball download verification (Node-download pin)", () => {
  const requireFromHere = createRequire(import.meta.url);
  const toolchain = requireFromHere(TOOLCHAIN_PATH);
  const {
    OFFICIAL_NODE_TARBALL_SHA256,
    lookupPinnedTarballDigest,
    parseShasumsEntry,
    digestsMatch,
  } = toolchain;

  const PINNED_VERSION = "v24.20.0";
  const PINNED_DARWIN_ARM64_DIGEST =
    OFFICIAL_NODE_TARBALL_SHA256[PINNED_VERSION]["darwin-arm64"];
  const PINNED_LINUX_X64_DIGEST =
    OFFICIAL_NODE_TARBALL_SHA256[PINNED_VERSION]["linux-x64"];

  // Built from the committed pins so the fixture cannot silently drift from
  // OFFICIAL_NODE_TARBALL_SHA256. One text-mode record, one binary-mode
  // (`*`) record, and two unpinned-but-real-looking records that exercise
  // "no matching line" without accidentally hitting a tuple nodejs.org
  // actually publishes for this version (aix-ppc64, darwin-{arm64,x64},
  // linux-{arm64,ppc64le,s390x,x64}).
  const SHASUMS_FIXTURE = [
    `${PINNED_DARWIN_ARM64_DIGEST}  node-${PINNED_VERSION}-darwin-arm64.tar.gz`,
    `${PINNED_LINUX_X64_DIGEST} *node-${PINNED_VERSION}-linux-x64.tar.gz`,
    "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef  " +
      `node-${PINNED_VERSION}-linux-arm64.tar.gz`,
  ].join("\n");

  describe("parseShasumsEntry", () => {
    it("returns the digest for a matching record", () => {
      expect(
        parseShasumsEntry(
          SHASUMS_FIXTURE,
          `node-${PINNED_VERSION}-darwin-arm64.tar.gz`,
        ),
      ).toBe(PINNED_DARWIN_ARM64_DIGEST.toLowerCase());
    });

    it("returns null when no line names the file (genuinely unpublished tuple)", () => {
      // solaris-sparc64 is not one of the tuples nodejs.org actually ships
      // for v24.20.0, so a real SHASUMS256.txt would not have this line
      // either - unlike aix/ppc64le/s390x, which DO exist and would make
      // this assertion pass for the wrong reason.
      expect(
        parseShasumsEntry(
          SHASUMS_FIXTURE,
          `node-${PINNED_VERSION}-solaris-sparc64.tar.gz`,
        ),
      ).toBeNull();
    });

    it("returns null for a filename from the wrong version", () => {
      expect(
        parseShasumsEntry(SHASUMS_FIXTURE, "node-v20.0.0-darwin-arm64.tar.gz"),
      ).toBeNull();
    });

    it("returns null on a truncated file with no complete record", () => {
      // Cuts the fixture mid-digest, before any filename appears - the
      // shape a download that died partway through would leave behind.
      const truncated = SHASUMS_FIXTURE.slice(0, 20);
      expect(
        parseShasumsEntry(
          truncated,
          `node-${PINNED_VERSION}-darwin-arm64.tar.gz`,
        ),
      ).toBeNull();
    });

    it("returns null for a record whose digest field is too short", () => {
      const shortDigestLine = `abc123  node-${PINNED_VERSION}-darwin-riscv64.tar.gz`;
      expect(
        parseShasumsEntry(
          shortDigestLine,
          `node-${PINNED_VERSION}-darwin-riscv64.tar.gz`,
        ),
      ).toBeNull();
    });

    it("parses a binary-mode `<digest> *<name>` record", () => {
      expect(
        parseShasumsEntry(
          SHASUMS_FIXTURE,
          `node-${PINNED_VERSION}-linux-x64.tar.gz`,
        ),
      ).toBe(PINNED_LINUX_X64_DIGEST.toLowerCase());
    });

    it("parses a CRLF-terminated line", () => {
      const crlfText = `${PINNED_DARWIN_ARM64_DIGEST}  node-${PINNED_VERSION}-darwin-arm64.tar.gz\r\n`;
      expect(
        parseShasumsEntry(
          crlfText,
          `node-${PINNED_VERSION}-darwin-arm64.tar.gz`,
        ),
      ).toBe(PINNED_DARWIN_ARM64_DIGEST.toLowerCase());
    });

    it("returns null when the requested filename is a strict prefix of a real entry", () => {
      expect(
        parseShasumsEntry(
          SHASUMS_FIXTURE,
          `node-${PINNED_VERSION}-darwin-arm64`,
        ),
      ).toBeNull();
    });
  });

  describe("lookupPinnedTarballDigest", () => {
    it("returns null for an unpinned version", () => {
      expect(
        lookupPinnedTarballDigest("v18.0.0", "darwin", "arm64"),
      ).toBeNull();
    });

    it("returns null for an unpinned arch under a pinned version", () => {
      expect(
        lookupPinnedTarballDigest(PINNED_VERSION, "darwin", "riscv64"),
      ).toBeNull();
    });

    it("returns null for 'toString' as the version (hasOwnProperty guard, not a prototype lookup)", () => {
      // Without the hasOwnProperty guard this would resolve
      // Object.prototype.toString and return a function instead of null.
      expect(
        lookupPinnedTarballDigest("toString", "darwin", "arm64"),
      ).toBeNull();
    });
  });

  describe("digestsMatch", () => {
    it("returns true for equal digests", () => {
      expect(
        digestsMatch(PINNED_DARWIN_ARM64_DIGEST, PINNED_DARWIN_ARM64_DIGEST),
      ).toBe(true);
    });

    it("returns false for different digests", () => {
      expect(
        digestsMatch(PINNED_DARWIN_ARM64_DIGEST, PINNED_LINUX_X64_DIGEST),
      ).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(
        digestsMatch(
          PINNED_DARWIN_ARM64_DIGEST.toUpperCase(),
          PINNED_DARWIN_ARM64_DIGEST.toLowerCase(),
        ),
      ).toBe(true);
    });

    it("returns false for malformed input", () => {
      expect(digestsMatch("not-a-digest", PINNED_DARWIN_ARM64_DIGEST)).toBe(
        false,
      );
    });

    it("returns false when either side is null", () => {
      expect(digestsMatch(null, PINNED_DARWIN_ARM64_DIGEST)).toBe(false);
      expect(digestsMatch(PINNED_DARWIN_ARM64_DIGEST, null)).toBe(false);
    });
  });

  describe("pin vs published SHASUMS agreement (the composed check production runs)", () => {
    // This is the exact composition `assertPinAgreesWithPublishedShasums`
    // performs: look up the committed pin, parse the published entry for
    // the same tarball name, and compare them. Exercised as a pair so a
    // `digestsMatch` that always returned false could not pass the
    // mismatch case for the wrong reason - the match case is the vacuity
    // guard for it.
    it("agrees for a tarball whose fixture digest matches the committed pin (darwin-arm64)", () => {
      expect(
        digestsMatch(
          lookupPinnedTarballDigest(PINNED_VERSION, "darwin", "arm64"),
          parseShasumsEntry(
            SHASUMS_FIXTURE,
            `node-${PINNED_VERSION}-darwin-arm64.tar.gz`,
          ),
        ),
      ).toBe(true);
    });

    it("disagrees for a tarball whose fixture digest was mis-entered against the committed pin (linux-arm64)", () => {
      // The fixture's linux-arm64 record is the fabricated `deadbeef...`
      // digest, deliberately different from the real committed pin. This
      // is the scenario `assertPinAgreesWithPublishedShasums` exists to
      // catch: a pin copied from the wrong row, where the tarball and the
      // stale pin agree with each other but not with what nodejs.org
      // actually published.
      expect(
        digestsMatch(
          lookupPinnedTarballDigest(PINNED_VERSION, "linux", "arm64"),
          parseShasumsEntry(
            SHASUMS_FIXTURE,
            `node-${PINNED_VERSION}-linux-arm64.tar.gz`,
          ),
        ),
      ).toBe(false);
    });
  });

  describe("OFFICIAL_NODE_TARBALL_SHA256 table integrity", () => {
    // The only tuples `officialNodeDistTuple()` can ever ask for (see its
    // `platform`/`arch` maps in sea-toolchain.cjs). A version row missing
    // one of these fails closed on exactly one platform, discovered only
    // by whoever builds there; an extra key is a typo (e.g.
    // `darwin-x86_64`) that will never be looked up and will sit there
    // looking correct forever.
    const SUPPORTED_TUPLES = [
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
    ];

    it("every digest is a 64-char lowercase hex string", () => {
      for (const [version, perVersion] of Object.entries(
        OFFICIAL_NODE_TARBALL_SHA256,
      )) {
        for (const [tuple, digest] of Object.entries(perVersion)) {
          expect(digest, `${version} ${tuple}`).toMatch(/^[0-9a-f]{64}$/);
        }
      }
    });

    it("every version carries exactly the four supported tuples, no more, no fewer", () => {
      for (const [version, perVersion] of Object.entries(
        OFFICIAL_NODE_TARBALL_SHA256,
      )) {
        expect(Object.keys(perVersion).sort(), version).toEqual(
          [...SUPPORTED_TUPLES].sort(),
        );
      }
    });

    it("every version key looks like v<major>.<minor>.<patch>", () => {
      for (const version of Object.keys(OFFICIAL_NODE_TARBALL_SHA256)) {
        expect(version).toMatch(/^v\d+\.\d+\.\d+$/);
      }
    });
  });
});

// Production wiring for `provisionOfficialNode`, as opposed to the helper
// tests above. That distinction is the whole point of this block: every test
// before it calls an exported pure function, so all of them would stay green
// if `provisionOfficialNode` stopped comparing digests altogether, or called
// `tar` before it hashed anything. Raised by the K2 cold review, which
// reproduced a real bypass that none of the helper tests could see.
//
// The technique is the cold review's: run the REAL module source in a vm with
// an injected `require`, a synthetic `__dirname` (so `REPO_ROOT`, and with it
// the cache directory, land in a temp tree) and an injected `spawnSync` that
// fakes `curl` and runs the real `tar` over tiny fixture archives. Only the
// pin value is substituted, because a fixture tarball cannot have the digest
// of the real one; lookup, hashing, comparison, ordering, staging, extraction
// and publication are the shipped code.
describe("provisionOfficialNode production wiring (K2 cold review)", () => {
  const VERSION = "v24.20.0";
  const PLATFORM = "darwin";
  const ARCH = "arm64";
  const TUPLE = `${PLATFORM}-${ARCH}`;
  const DIST = `node-${VERSION}-${TUPLE}`;
  const TARBALL_NAME = `${DIST}.tar.gz`;
  const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

  const SOURCE = readFileSync(
    path.join(REPO_ROOT, "scripts", "native-packaging", "sea-toolchain.cjs"),
    "utf8",
  );

  function sha256(file) {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  }

  // A minimal but REAL gzipped tar with the expected `<dist>/bin/node` layout,
  // whose "binary" carries the fuse sentinel so the post-extract checks pass.
  function makeArchive(scratch, label) {
    const stageDir = path.join(scratch, `stage-${label}`);
    const binDir = path.join(stageDir, DIST, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, "node"), `${label} ${SENTINEL}`, {
      mode: 0o755,
    });
    const file = path.join(scratch, `${label}.tar.gz`);
    execFileSync("tar", ["-czf", file, "-C", stageDir, DIST]);
    return file;
  }

  /**
   * Drive the real `provisionOfficialNode` over a synthetic filesystem.
   *
   * `interleave` is the race: a function called at the moment `tar` is about
   * to run, standing in for a SECOND provisioner on the same machine (the host
   * SEA build and the CLI SEA build are separate invocations) finishing its
   * own download. It receives the predictable shared pathname that the
   * pre-fix code downloaded to.
   */
  function drive({
    scratch,
    goodTarball,
    badTarball,
    pin,
    badDownload,
    interleave,
    version,
    syntheticRoot: presetRoot,
    shasumsStatus,
    shasumsBody,
    tarFails,
    failStagedExtractMkdir,
  }) {
    const syntheticRoot =
      presetRoot ?? mkdtempSync(path.join(scratch, "root-"));
    const cacheRoot = path.join(
      syntheticRoot,
      "node_modules",
      ".cache",
      "traycer-sea-node",
    );
    const sharedTarballPath = path.join(cacheRoot, TARBALL_NAME);
    const calls = [];
    let tarballSeenByTar = null;

    const spawnSync = (command, args) => {
      const last = args.at(-1);
      if (
        command === "curl" &&
        typeof last === "string" &&
        last.endsWith("SHASUMS256.txt")
      ) {
        calls.push("curl:shasums");
        if (shasumsStatus !== undefined && shasumsStatus !== 0) {
          return { status: shasumsStatus, stdout: "" };
        }
        return {
          status: 0,
          stdout: shasumsBody ?? `${pin}  ${TARBALL_NAME}\n`,
        };
      }
      if (command === "curl") {
        calls.push("curl:tarball");
        copyFileSync(
          badDownload ? badTarball : goodTarball,
          args[args.indexOf("-o") + 1],
        );
        return { status: 0 };
      }
      if (command === "tar") {
        calls.push("tar");
        if (tarFails === true) {
          return { status: 1 };
        }
        const target = args[args.indexOf("-xzf") + 1];
        if (interleave !== undefined) {
          interleave({ sharedTarballPath, targetGivenToTar: target });
        }
        tarballSeenByTar = target;
        // Real tar over the real staged archive: extraction is part of what
        // these cases are asserting about, so it is not stubbed.
        try {
          execFileSync("tar", args, { stdio: "ignore" });
          return { status: 0 };
        } catch {
          return { status: 1 };
        }
      }
      throw new Error(`Unexpected subprocess: ${command}`);
    };

    const moduleObj = { exports: {} };
    const context = createContext({
      module: moduleObj,
      exports: moduleObj.exports,
      __dirname: path.join(syntheticRoot, "scripts", "native-packaging"),
      Buffer,
      console: { warn() {}, log() {} },
      process: {
        version: version ?? VERSION,
        platform: PLATFORM,
        arch: ARCH,
        execPath: path.join(syntheticRoot, "host-node"),
        versions: {},
        env: {},
      },
      require: (name) => {
        if (name === "node:child_process") return { spawnSync, execFileSync };
        if (name === "node:fs" && failStagedExtractMkdir === true) {
          // Make the staging directory's own `ensureDir` throw, which is the
          // one failure between `mkdtemp` and the cleanup `finally`. Injected
          // through `require` because there is no filesystem state that
          // reproduces it: the staging path is random by construction.
          const realFs = createRequire(import.meta.url)("node:fs");
          return {
            ...realFs,
            mkdirSync(target, options) {
              if (String(target).endsWith(`${path.sep}x`)) {
                throw new Error("EACCES: simulated staging mkdir failure");
              }
              return realFs.mkdirSync(target, options);
            },
          };
        }
        if (name === "esbuild") return {};
        if (name.startsWith("node:"))
          return createRequire(import.meta.url)(name);
        throw new Error(`Unexpected import: ${name}`);
      },
    });
    runInContext(
      `${SOURCE}\nmodule.exports.__drive = provisionOfficialNode;`,
      context,
    );
    // The ONLY substitution: a fixture archive cannot carry the real tarball's
    // digest. Everything the test is about - the comparison, its ordering
    // against tar, the staging paths - is the shipped code.
    if (pin !== null) {
      moduleObj.exports.OFFICIAL_NODE_TARBALL_SHA256[VERSION][TUPLE] = pin;
    }

    let returned = null;
    let error = null;
    try {
      returned = moduleObj.exports.__drive();
    } catch (thrown) {
      error = thrown;
    }
    return {
      returned,
      error,
      calls,
      cacheRoot,
      sharedTarballPath,
      tarballSeenByTar,
      returnedBytes: returned === null ? null : readFileSync(returned, "utf8"),
      // Residue is only observable from OUTSIDE the function, and `afterAll`
      // would wipe it, so it is captured here at the moment the call returns.
      stagingLeftovers: existsSync(cacheRoot)
        ? readdirSync(cacheRoot).filter((entry) =>
            entry.startsWith("download-"),
          )
        : [],
    };
  }

  let scratch;
  let goodTarball;
  let badTarball;
  let goodPin;
  let badDigest;

  beforeAll(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "sea-provision-wiring-"));
    goodTarball = makeArchive(scratch, "verified");
    badTarball = makeArchive(scratch, "unverified");
    goodPin = sha256(goodTarball);
    badDigest = sha256(badTarball);
    // The fixtures must actually differ, or every assertion below is vacuous.
    expect(goodPin).not.toBe(badDigest);
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("POSITIVE CONTROL: a tarball matching the pin is extracted and its binary returned", () => {
    const run = drive({ scratch, goodTarball, badTarball, pin: goodPin });

    expect(run.error).toBeNull();
    expect(run.returnedBytes).toMatch(/^verified /);
    expect(run.calls).toEqual(["curl:shasums", "curl:tarball", "tar"]);
  });

  it("refuses a tarball whose digest does not match the pin, and never reaches tar", () => {
    // The wiring assertion the helper tests cannot make: if the digest
    // comparison were deleted from `provisionOfficialNode`, every pure test
    // above would still pass and this one would fail.
    const run = drive({
      scratch,
      goodTarball,
      badTarball,
      pin: goodPin,
      badDownload: true,
    });

    expect(run.error).not.toBeNull();
    expect(run.error.message).toMatch(/SHA-256 mismatch/);
    expect(run.error.message).toContain(goodPin);
    expect(run.error.message).toContain(badDigest);
    // Ordering is the point: extraction of unverified bytes is the thing
    // being prevented, so `tar` must not appear at all.
    expect(run.calls).not.toContain("tar");
    expect(run.returned).toBeNull();
  });

  it("a second provisioner writing the predictable shared path cannot substitute the extracted bytes", () => {
    // The cold review's reproduction. Pre-fix, the download went to
    // `<cacheRoot>/<tarballName>` - a pathname every concurrent invocation
    // computes identically - and `tar` REOPENED it after the hash had closed
    // it. A competing `curl -o` in that window truncated the verified file in
    // place and tar unpacked bytes this invocation never checked.
    let plantedAt = null;
    const run = drive({
      scratch,
      goodTarball,
      badTarball,
      pin: goodPin,
      interleave: ({ sharedTarballPath }) => {
        mkdirSync(path.dirname(sharedTarballPath), { recursive: true });
        copyFileSync(badTarball, sharedTarballPath);
        plantedAt = sharedTarballPath;
      },
    });

    // The plant really happened - otherwise this test would pass by doing
    // nothing, which is exactly the failure mode being guarded against.
    expect(plantedAt).not.toBeNull();
    expect(sha256(plantedAt)).toBe(badDigest);

    // And it changed nothing, because the file tar opens is private to this
    // invocation rather than the pathname the attacker can name.
    expect(run.error).toBeNull();
    expect(run.returnedBytes).toMatch(/^verified /);
    expect(run.tarballSeenByTar).not.toBe(run.sharedTarballPath);
    expect(run.tarballSeenByTar.startsWith(run.cacheRoot)).toBe(true);
  });

  it("does not reuse a cache entry published by the pre-namespace scheme", () => {
    // Raised by the cold review. The FIRST verified scheme could publish
    // unverified bytes under the key naming the GOOD digest, because its
    // download path was shared and tar reopened it after hashing. Those keys
    // are indistinguishable from correct ones, so the scheme namespace - not
    // the digest - is what retires them. Without the bump this poisoned tree
    // would be returned by the fast path with no subprocess at all.
    const syntheticRoot = mkdtempSync(path.join(scratch, "oldkey-"));
    const oldBinDir = path.join(
      syntheticRoot,
      "node_modules",
      ".cache",
      "traycer-sea-node",
      `${VERSION}-${TUPLE}-${goodPin}`,
      DIST,
      "bin",
    );
    mkdirSync(oldBinDir, { recursive: true });
    writeFileSync(path.join(oldBinDir, "node"), `poisoned ${SENTINEL}`, {
      mode: 0o755,
    });

    const run = drive({
      scratch,
      goodTarball,
      badTarball,
      pin: goodPin,
      syntheticRoot,
    });

    expect(run.error).toBeNull();
    // It re-provisioned instead of trusting the old key...
    expect(run.calls).toEqual(["curl:shasums", "curl:tarball", "tar"]);
    // ...and returned the verified tarball, not the planted tree.
    expect(run.returnedBytes).toMatch(/^verified /);
    expect(run.returnedBytes).not.toMatch(/^poisoned /);
  });

  it("does not mistake a half-published tree for a winner of the publish race", () => {
    // The rename-loser branch must excuse ONLY "another invocation already
    // published a USABLE tree here". The dangerous near-miss is a destination
    // that exists and is non-empty - so the rename fails ENOTEMPTY - but
    // whose binary is not a real one. Testing presence alone would swallow
    // that error and return a path to a binary with no SEA fuse, which is
    // precisely the thing every other check in this function exists to
    // prevent, arrived at through the error path instead of the happy one.
    const syntheticRoot = mkdtempSync(path.join(scratch, "halfpublished-"));
    const occupiedBinDir = path.join(
      syntheticRoot,
      "node_modules",
      ".cache",
      "traycer-sea-node",
      `s2-${VERSION}-${TUPLE}-${goodPin}`,
      DIST,
      "bin",
    );
    mkdirSync(occupiedBinDir, { recursive: true });
    // Present, non-empty, and NOT fuse-bearing: a torn publish, not a winner.
    writeFileSync(path.join(occupiedBinDir, "node"), "truncated", {
      mode: 0o755,
    });

    const run = drive({
      scratch,
      goodTarball,
      badTarball,
      pin: goodPin,
      syntheticRoot,
    });

    expect(run.error).not.toBeNull();
    expect(run.returned).toBeNull();
    // It got as far as extracting, so this is the publication step failing
    // rather than an earlier guard rejecting the input.
    expect(run.calls).toContain("tar");
  });

  // The SHASUMS cross-check's three refusal branches. Raised by the second
  // cold review: every case above forced a SUCCESSFUL matching fetch, so all
  // three `throw`s in `assertPinAgreesWithPublishedShasums` could have been
  // deleted with the suite still green.
  it("refuses when the published SHASUMS cannot be fetched", () => {
    const run = drive({
      scratch,
      goodTarball,
      badTarball,
      pin: goodPin,
      shasumsStatus: 22,
    });

    expect(run.error).not.toBeNull();
    expect(run.error.message).toMatch(/Could not fetch/);
    // Refused at the cross-check, so the 50 MB download never starts.
    expect(run.calls).toEqual(["curl:shasums"]);
    expect(run.stagingLeftovers).toEqual([]);
  });

  it("refuses when the published SHASUMS has no entry for the tarball", () => {
    const run = drive({
      scratch,
      goodTarball,
      badTarball,
      pin: goodPin,
      shasumsBody: `${"0".repeat(64)}  node-v24.20.0-linux-s390x.tar.gz\n`,
    });

    expect(run.error).not.toBeNull();
    expect(run.error.message).toMatch(/no SHA-256 entry/);
    expect(run.calls).toEqual(["curl:shasums"]);
  });

  it("refuses when the published SHASUMS disagrees with the committed pin", () => {
    const run = drive({
      scratch,
      goodTarball,
      badTarball,
      pin: goodPin,
      shasumsBody: `${badDigest}  ${TARBALL_NAME}\n`,
    });

    expect(run.error).not.toBeNull();
    expect(run.error.message).toMatch(/disagrees with/);
    expect(run.error.message).toContain(goodPin);
    expect(run.error.message).toContain(badDigest);
    expect(run.calls).toEqual(["curl:shasums"]);
  });

  it("accepts a completed competing publisher and returns its tree", () => {
    // The other side of the rename-loser branch, and the reason it cannot
    // simply throw: a concurrent invocation that has ALREADY published a
    // complete, fuse-bearing tree at this key is a legitimate winner. Without
    // a case here, replacing the catch body with an unconditional `throw`
    // would leave the suite green while breaking every concurrent build.
    const syntheticRoot = mkdtempSync(path.join(scratch, "winner-"));
    const run = drive({
      scratch,
      goodTarball,
      badTarball,
      pin: goodPin,
      syntheticRoot,
      interleave: () => {
        // Publish a COMPLETE tree at the destination while this invocation
        // is still extracting, exactly as a second provisioner would.
        const winnerBin = path.join(
          syntheticRoot,
          "node_modules",
          ".cache",
          "traycer-sea-node",
          `s2-${VERSION}-${TUPLE}-${goodPin}`,
          DIST,
          "bin",
        );
        mkdirSync(winnerBin, { recursive: true });
        writeFileSync(path.join(winnerBin, "node"), `winner ${SENTINEL}`, {
          mode: 0o755,
        });
      },
    });

    expect(run.error).toBeNull();
    // Losing the publish race is a success, and the bytes are the winner's.
    expect(run.returnedBytes).toMatch(/^winner /);
    expect(run.calls).toContain("tar");
    expect(run.stagingLeftovers).toEqual([]);
  });

  it("leaves no staging directory behind on success", () => {
    const run = drive({ scratch, goodTarball, badTarball, pin: goodPin });
    expect(run.error).toBeNull();
    expect(run.stagingLeftovers).toEqual([]);
  });

  it("leaves no staging directory behind when the digest does not match", () => {
    const run = drive({
      scratch,
      goodTarball,
      badTarball,
      pin: goodPin,
      badDownload: true,
    });
    expect(run.error).not.toBeNull();
    // The rejected tarball is gone too, so a re-run cannot pick it up.
    expect(run.stagingLeftovers).toEqual([]);
  });

  it("leaves no staging directory behind when extraction fails", () => {
    const run = drive({
      scratch,
      goodTarball,
      badTarball,
      pin: goodPin,
      tarFails: true,
    });
    expect(run.error).not.toBeNull();
    expect(run.error.message).toMatch(/Failed to extract/);
    expect(run.stagingLeftovers).toEqual([]);
  });

  it("leaves no staging directory behind when staging setup itself fails", () => {
    // The gap the second cold review found in the fix: `mkdtemp` created the
    // directory, but the `ensureDir` immediately after it sat OUTSIDE the
    // try, so the one failure the cleanup existed for was the one it did not
    // cover. Everything after the mkdtemp is inside the try now.
    const run = drive({
      scratch,
      goodTarball,
      badTarball,
      pin: goodPin,
      failStagedExtractMkdir: true,
    });

    expect(run.error).not.toBeNull();
    expect(run.error.message).toMatch(/simulated staging mkdir failure/);
    expect(run.stagingLeftovers).toEqual([]);
  });

  it("refuses an unpinned version before any network call is made", () => {
    const run = drive({
      scratch,
      goodTarball,
      badTarball,
      pin: null,
      version: "v0.0.1-unpinned",
    });

    expect(run.error).not.toBeNull();
    expect(run.error.message).toMatch(/No pinned SHA-256/);
    // Fail closed BEFORE the network, not after: nothing was fetched at all.
    expect(run.calls).toEqual([]);
  });
});
