import { chmod, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBoundedFile } from "../bounded-file";

/**
 * `readBoundedFile` in isolation: the size/kind checks `import-logins.ts`
 * depends on, against real files in a temp dir. Production uses
 * `MAX_LOGIN_IMPORT_FILE_BYTES` (64 MiB); a small bound is used here instead
 * so the "too-large" case does not have to allocate anything close to that -
 * `truncate` makes the fixture sparse, so even the 64 MiB case elsewhere
 * (covered in `import-logins.test.ts`) is instant on disk.
 */

let root: string;

afterEach(async () => {
  if (root !== undefined) {
    await chmod(root, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

describe("readBoundedFile", () => {
  it("reads a regular file under the bound and answers its exact bytes", async () => {
    root = await mkdtemp(join(tmpdir(), "bounded-file-ok-"));
    const path = join(root, "cookies.txt");
    const content = "hello-cookie-export";
    await writeFile(path, content);

    const result = await readBoundedFile(path, 1024);

    expect(result).toEqual({ ok: true, bytes: Buffer.from(content) });
  });

  it("answers not-a-file for a directory", async () => {
    root = await mkdtemp(join(tmpdir(), "bounded-file-dir-"));

    const result = await readBoundedFile(root, 1024);

    expect(result).toEqual({ ok: false, reason: "not-a-file" });
  });

  it("answers too-large for a file over the bound", async () => {
    root = await mkdtemp(join(tmpdir(), "bounded-file-large-"));
    const path = join(root, "huge.txt");
    const maxBytes = 16;
    await writeFile(path, "");
    // Sparse and instant: no need to actually write maxBytes+1 bytes to disk.
    await truncate(path, maxBytes + 1);

    const result = await readBoundedFile(path, maxBytes);

    expect(result).toEqual({ ok: false, reason: "too-large" });
  });

  it("answers unreadable for a missing path", async () => {
    root = await mkdtemp(join(tmpdir(), "bounded-file-missing-"));
    const path = join(root, "does-not-exist.txt");

    const result = await readBoundedFile(path, 1024);

    expect(result).toEqual({ ok: false, reason: "unreadable" });
  });

  it("answers denied for a file this process cannot read", async () => {
    // Root (and, on Windows, chmod's semantics) can read past this - so the
    // case is skipped rather than asserted falsely there.
    if (process.getuid?.() === 0 || process.platform === "win32") return;
    root = await mkdtemp(join(tmpdir(), "bounded-file-denied-"));
    const path = join(root, "no-access.txt");
    await writeFile(path, "secret");
    await chmod(path, 0o000);

    const result = await readBoundedFile(path, 1024);

    expect(result).toEqual({ ok: false, reason: "denied" });
  });
});
