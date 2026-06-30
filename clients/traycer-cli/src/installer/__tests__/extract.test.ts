import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { c as tarCreate } from "tar";
import { extractHostSource } from "../extract";
import { CliError } from "../../runner/errors";

// CRC32 used by buildZipWithEntry below. Inlined so the test stays
// self-contained (we don't depend on `archiver` or a CRC helper from a
// runtime dep - the zip-write path in production never builds archives,
// only consumes them).
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = crc ^ byte;
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Build a minimal single-entry ZIP archive whose entry name is exactly
// `entryName` (no normalisation), with the supplied stored (uncompressed)
// content. Used to exercise the zip traversal rejection path.
function buildZipWithEntry(entryName: string, data: string): Buffer {
  const nameBuf = Buffer.from(entryName, "utf8");
  const dataBuf = Buffer.from(data, "utf8");
  const crc = crc32(dataBuf);
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(0, 6);
  lfh.writeUInt16LE(0, 8);
  lfh.writeUInt16LE(0, 10);
  lfh.writeUInt16LE(0, 12);
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(dataBuf.length, 18);
  lfh.writeUInt32LE(dataBuf.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  lfh.writeUInt16LE(0, 28);
  const localChunk = Buffer.concat([lfh, nameBuf, dataBuf]);

  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt16LE(0, 8);
  cdh.writeUInt16LE(0, 10);
  cdh.writeUInt16LE(0, 12);
  cdh.writeUInt16LE(0, 14);
  cdh.writeUInt32LE(crc, 16);
  cdh.writeUInt32LE(dataBuf.length, 20);
  cdh.writeUInt32LE(dataBuf.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt16LE(0, 30);
  cdh.writeUInt16LE(0, 32);
  cdh.writeUInt16LE(0, 34);
  cdh.writeUInt16LE(0, 36);
  cdh.writeUInt32LE(0, 38);
  cdh.writeUInt32LE(0, 42);
  const centralChunk = Buffer.concat([cdh, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralChunk.length, 12);
  eocd.writeUInt32LE(localChunk.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localChunk, centralChunk, eocd]);
}

// Verifies the in-process tar/zip extraction enforces path-traversal
// protection. The local-file install path (`host install --from
// <archive>`) bypasses minisign verification, so this is the only
// defence against a malicious archive escaping the staging directory.

let scratchRoot: string;

beforeAll(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), "traycer-cli-extract-"));
});

afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

describe("extractHostSource (tar)", () => {
  it("extracts a benign archive into the target dir", async () => {
    const sourceDir = mkdtempSync(join(scratchRoot, "src-"));
    writeFileSync(join(sourceDir, "ok.txt"), "ok\n");
    const archive = join(scratchRoot, "benign.tar");
    await tarCreate({ file: archive, cwd: sourceDir }, ["ok.txt"]);
    const targetDir = mkdtempSync(join(scratchRoot, "tgt-"));
    await extractHostSource({ source: archive, targetDir });
    const contents = await readFile(join(targetDir, "ok.txt"), "utf8");
    expect(contents).toBe("ok\n");
  });

  it("rejects a tar entry that escapes the target dir with a leading ..", async () => {
    // Build a tarball whose single entry is named `../escape`. We can
    // express this via the tar package's `add` API only with a literal
    // file path that survives `path.normalize`, so we generate the
    // archive bytes manually via tar's create stream with an explicit
    // entry name override.
    const sourceDir = mkdtempSync(join(scratchRoot, "src-"));
    // Create a file literally named `escape` and then re-tar it with a
    // header `prefix` of `..` so the resulting entry name is `../escape`.
    writeFileSync(join(sourceDir, "escape"), "evil");
    const archive = join(scratchRoot, "evil.tar");
    await tarCreate(
      {
        file: archive,
        cwd: sourceDir,
        prefix: "..",
      },
      ["escape"],
    );
    const targetDir = mkdtempSync(join(scratchRoot, "tgt-"));
    let caught: unknown = null;
    try {
      await extractHostSource({ source: archive, targetDir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    if (caught instanceof CliError) {
      expect(caught.code).toBe("E_HOST_INSTALL_FAILED");
      expect(caught.message).toMatch(/refused unsafe tar entry/);
    }
    // And nothing was extracted outside the target dir.
    const targetEntries = await readdir(targetDir);
    expect(targetEntries).toEqual([]);
  });

  it("tolerates plain leading-dot entries (e.g. .traycer-marker)", async () => {
    const sourceDir = mkdtempSync(join(scratchRoot, "src-"));
    writeFileSync(join(sourceDir, ".marker"), "hi");
    const archive = join(scratchRoot, "dotfile.tar");
    await tarCreate({ file: archive, cwd: sourceDir }, [".marker"]);
    const targetDir = mkdtempSync(join(scratchRoot, "tgt-"));
    await extractHostSource({ source: archive, targetDir });
    const markerStat = await stat(join(targetDir, ".marker"));
    expect(markerStat.isFile()).toBe(true);
  });

  it("rejects tar archive with absolute-path entry", async () => {
    // Build a tarball whose single entry name is `/etc/foo` (absolute).
    // The `prefix` create option is concatenated as `<prefix>/<name>`, so
    // a prefix of `/etc` and an entry name of `foo` yields an absolute
    // entry. Verified via tar's list API: see scripts in repo history.
    const sourceDir = mkdtempSync(join(scratchRoot, "src-"));
    writeFileSync(join(sourceDir, "foo"), "data");
    const archive = join(scratchRoot, "absolute.tar");
    await tarCreate({ file: archive, cwd: sourceDir, prefix: "/etc" }, ["foo"]);
    const targetDir = mkdtempSync(join(scratchRoot, "tgt-"));
    let caught: unknown = null;
    try {
      await extractHostSource({ source: archive, targetDir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    if (caught instanceof CliError) {
      expect(caught.code).toBe("E_HOST_INSTALL_FAILED");
      expect(caught.message).toMatch(/refused unsafe tar entry/);
    }
    // Nothing was extracted under the target dir, and (critically) the
    // extractor did NOT write to /etc/foo on the host.
    const targetEntries = await readdir(targetDir);
    expect(targetEntries).toEqual([]);
  });

  it("rejects tar archive with symlink target traversal", async () => {
    // The `tar` package packs a symlink entry as a SymbolicLink whose
    // `linkpath` is the symlink target. Our extract guard inspects
    // `linkpath` and rejects anything containing a `..` segment.
    if (osPlatform() === "win32") {
      // Symlink creation on Windows usually requires elevation. Skip
      // rather than fail in unprivileged CI; the unit test asserting
      // unsafeEntryReason() already covers the pure-logic branch.
      return;
    }
    const sourceDir = mkdtempSync(join(scratchRoot, "src-"));
    symlinkSync("../../etc/passwd", join(sourceDir, "link"));
    const archive = join(scratchRoot, "symlink-traversal.tar");
    await tarCreate({ file: archive, cwd: sourceDir }, ["link"]);
    const targetDir = mkdtempSync(join(scratchRoot, "tgt-"));
    let caught: unknown = null;
    try {
      await extractHostSource({ source: archive, targetDir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    if (caught instanceof CliError) {
      expect(caught.code).toBe("E_HOST_INSTALL_FAILED");
      expect(caught.message).toMatch(/refused unsafe tar entry/);
    }
    const targetEntries = await readdir(targetDir);
    expect(targetEntries).toEqual([]);
  });

  it("rejects zip archive with traversal entry name", async () => {
    // Build a raw ZIP with a single entry named `../escape`. Both our
    // pre-flight scan in extractZipArchive() and the `node-stream-zip`
    // library's own `validateName()` reject such names - either path is
    // an acceptable failure mode (the install path is closed in both).
    const archive = join(scratchRoot, "evil.zip");
    writeFileSync(archive, buildZipWithEntry("../escape", "evil"));
    const targetDir = mkdtempSync(join(scratchRoot, "tgt-"));
    let caught: unknown = null;
    try {
      await extractHostSource({ source: archive, targetDir });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    // Accept either our HOST_INSTALL_FAILED CliError or the upstream
    // library's "Malicious entry" Error - both close the install path.
    if (caught instanceof CliError) {
      expect(caught.code).toBe("E_HOST_INSTALL_FAILED");
      expect(caught.message).toMatch(/refused unsafe zip entry/);
    } else if (caught instanceof Error) {
      expect(caught.message).toMatch(/Malicious entry|refused unsafe/);
    }
    const targetEntries = await readdir(targetDir);
    expect(targetEntries).toEqual([]);
  });
});
