import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { externalActionSchema } from "@traycer/protocol/config/data-migration-contracts";
import {
  compareAndSetFileImage,
  decodeImage,
  encodeImage,
  ExternalActionConflictError,
  externalActionId,
  fileImageFingerprint,
  isExternalActionConflictError,
  pathInsideRoot,
  readFileImage,
  rebaseRootPath,
  samePath,
} from "../ledger";

describe("pathInsideRoot (win32)", () => {
  const root = "D:\\Data";

  it("is case- and separator-insensitive but keeps the original spelling", () => {
    expect(pathInsideRoot("d:/data/Cli/Bin", root, "win32")).toBe("Cli\\Bin");
    expect(pathInsideRoot("D:\\DATA\\a\\b", root, "win32")).toBe("a\\b");
  });

  it("returns the empty string for the root itself, with or without a trailing separator", () => {
    expect(pathInsideRoot("D:\\Data", root, "win32")).toBe("");
    expect(pathInsideRoot("d:/data/", root, "win32")).toBe("");
  });

  it("respects segment boundaries", () => {
    expect(pathInsideRoot("D:\\Data2\\x", root, "win32")).toBeNull();
    expect(pathInsideRoot("D:\\Data2", root, "win32")).toBeNull();
    expect(pathInsideRoot("D:\\Dat", root, "win32")).toBeNull();
    expect(pathInsideRoot("E:\\Data\\x", root, "win32")).toBeNull();
  });

  it("preserves Unicode and spaces in the relative part", () => {
    expect(
      pathInsideRoot(
        "C:\\Users\\Zoë Q\\.traycer\\Wörk Tree\\ü",
        "C:\\Users\\Zoë Q\\.traycer",
        "win32",
      ),
    ).toBe("Wörk Tree\\ü");
  });
});

describe("pathInsideRoot (posix)", () => {
  it("is case-sensitive and boundary-aware", () => {
    expect(pathInsideRoot("/data/a/b", "/data", "posix")).toBe("a/b");
    expect(pathInsideRoot("/Data/a", "/data", "posix")).toBeNull();
    expect(pathInsideRoot("/data2/a", "/data", "posix")).toBeNull();
    expect(pathInsideRoot("/data", "/data", "posix")).toBe("");
  });
});

describe("samePath", () => {
  it("folds case and separators on win32 only", () => {
    expect(samePath("C:\\A\\b", "c:/a/B/", "win32")).toBe(true);
    expect(samePath("/a/b", "/a/B", "posix")).toBe(false);
  });
});

describe("rebaseRootPath", () => {
  it("moves a path from one root to another keeping the relative spelling", () => {
    expect(
      rebaseRootPath(
        "C:\\Users\\Zoë Q\\.traycer\\cli\\bin\\Traycer.exe",
        "C:\\Users\\Zoë Q\\.traycer",
        "D:\\Träycer Data",
        "win32",
      ),
    ).toBe("D:\\Träycer Data\\cli\\bin\\Traycer.exe");
  });

  it("maps the root itself to the destination root", () => {
    expect(rebaseRootPath("D:\\Data", "d:/data", "E:\\New", "win32")).toBe(
      "E:\\New",
    );
  });

  it("returns null for a path outside the root, including a sibling prefix", () => {
    expect(
      rebaseRootPath("D:\\Data2\\x", "D:\\Data", "E:\\New", "win32"),
    ).toBeNull();
    expect(
      rebaseRootPath("/usr/bin/traycer", "/data", "/new", "posix"),
    ).toBeNull();
  });
});

describe("externalActionId", () => {
  it("matches the protocol's id regex and is stable", () => {
    const id = externalActionId("file", "prepare", "C:\\x\\y z\\ü.vbs");
    expect(id).toMatch(/^[a-z0-9][a-z0-9.-]{0,79}$/u);
    expect(id).toMatch(/^file\.[0-9a-f]{24}$/u);
    expect(externalActionId("file", "prepare", "C:\\x\\y z\\ü.vbs")).toBe(id);
    // The protocol schema accepts it as an id.
    expect(externalActionSchema.shape.id.safeParse(id).success).toBe(true);
  });

  it("differs when any naming part differs, including how parts are split", () => {
    const base = externalActionId("p", "ab", "c");
    expect(externalActionId("p", "a", "bc")).not.toBe(base);
    expect(externalActionId("p", "ab", "d")).not.toBe(base);
    expect(externalActionId("q", "ab", "c")).not.toBe(base);
  });
});

describe("image encoding", () => {
  it("round-trips arbitrary bytes and null", () => {
    const bytes = Buffer.from([0, 255, 1, 254, 0x0d, 0x0a]);
    expect(decodeImage(encodeImage(bytes))?.equals(bytes)).toBe(true);
    expect(encodeImage(null)).toBeNull();
    expect(decodeImage(null)).toBeNull();
  });

  it("fingerprints absent vs present and by content", () => {
    expect(fileImageFingerprint(null)).toEqual({ kind: "absent" });
    const a = fileImageFingerprint(Buffer.from("a"));
    expect(a.kind).toBe("present");
    expect(fileImageFingerprint(Buffer.from("a"))).toEqual(a);
    expect(fileImageFingerprint(Buffer.from("b"))).not.toEqual(a);
  });
});

describe("compareAndSetFileImage", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "traycer-ledger-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes when the current bytes match the expected image", async () => {
    const path = join(dir, "f.bin");
    await writeFile(path, Buffer.from([1, 2, 3]));
    await compareAndSetFileImage(
      path,
      Buffer.from([1, 2, 3]),
      Buffer.from([9, 0, 9]),
    );
    expect((await readFile(path)).equals(Buffer.from([9, 0, 9]))).toBe(true);
    // No temp file is left behind.
    expect(await readdir(dir)).toEqual(["f.bin"]);
  });

  it("raises a conflict on mismatch and leaves the bytes untouched", async () => {
    const path = join(dir, "f.bin");
    await writeFile(path, "changed");
    const attempt = compareAndSetFileImage(
      path,
      Buffer.from("expected"),
      Buffer.from("next"),
    );
    await expect(attempt).rejects.toBeInstanceOf(ExternalActionConflictError);
    await attempt.catch((cause: unknown) => {
      expect(isExternalActionConflictError(cause)).toBe(true);
      if (isExternalActionConflictError(cause)) expect(cause.object).toBe(path);
    });
    expect(await readFile(path, "utf8")).toBe("changed");
    expect(await readdir(dir)).toEqual(["f.bin"]);
  });

  it("creates a file that was absent (absent -> present)", async () => {
    const path = join(dir, "new.bin");
    await compareAndSetFileImage(path, null, Buffer.from("hello"));
    expect(await readFile(path, "utf8")).toBe("hello");
  });

  it("conflicts when it expected absence but the file exists", async () => {
    const path = join(dir, "there.bin");
    await writeFile(path, "x");
    await expect(
      compareAndSetFileImage(path, null, Buffer.from("y")),
    ).rejects.toBeInstanceOf(ExternalActionConflictError);
    expect(await readFile(path, "utf8")).toBe("x");
  });

  it("removes a file (present -> absent) and conflicts when it expected presence of an absent file", async () => {
    const path = join(dir, "gone.bin");
    await writeFile(path, "x");
    await compareAndSetFileImage(path, Buffer.from("x"), null);
    expect(await readFileImage(path)).toBeNull();
    await expect(
      compareAndSetFileImage(path, Buffer.from("x"), null),
    ).rejects.toBeInstanceOf(ExternalActionConflictError);
  });

  it("refuses a directory as a conflict rather than reading it", async () => {
    await expect(readFileImage(dir)).rejects.toBeInstanceOf(
      ExternalActionConflictError,
    );
  });
});
