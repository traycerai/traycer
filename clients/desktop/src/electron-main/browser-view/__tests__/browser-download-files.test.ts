import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserDownloadFiles } from "../browser-download";
import { nodeBrowserDownloadFiles } from "../browser-download-files";

vi.mock("../../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
  describeLogError: (error: unknown): string => String(error),
}));

const linkProbe = vi.hoisted(() => ({
  calls: [] as Array<{ readonly from: string; readonly to: string }>,
}));

let directory = "";

beforeEach(() => {
  linkProbe.calls.length = 0;
  directory = mkdtempSync(join(tmpdir(), "traycer-download-files-"));
});

afterEach(() => {
  vi.doUnmock("node:fs/promises");
  rmSync(directory, { recursive: true, force: true });
});

function write(name: string, bytes: string): string {
  const path = join(directory, name);
  writeFileSync(path, bytes);
  return path;
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("nodeBrowserDownloadFiles", () => {
  it("publishes to a free name, moving the bytes and removing the held file", async () => {
    const held = write("Unconfirmed 1.traycer-download", "payload");
    const target = join(directory, "file.txt");

    await expect(nodeBrowserDownloadFiles.publish(held, target)).resolves.toBe(
      "published",
    );

    expect(read(target)).toBe("payload");
    expect(existsSync(held)).toBe(false);
  });

  it("answers exists for a taken name and leaves both files intact", async () => {
    const held = write("Unconfirmed 2.traycer-download", "new bytes");
    const target = write("file.txt", "old bytes");

    await expect(nodeBrowserDownloadFiles.publish(held, target)).resolves.toBe(
      "exists",
    );

    expect(read(target)).toBe("old bytes");
    expect(read(held)).toBe("new bytes");
  });

  it("never changes an existing file's bytes for a name that differs only by case", async () => {
    const held = write("Unconfirmed 3.traycer-download", "new bytes");
    const existing = write("file.txt", "old bytes");

    const answer = await nodeBrowserDownloadFiles.publish(
      held,
      join(directory, "FILE.TXT"),
    );

    // Which answer is the volume's to give; the existing bytes are not.
    expect(read(existing)).toBe("old bytes");
    expect(["published", "exists"]).toContain(answer);
    if (answer === "exists") expect(read(held)).toBe("new bytes");
  });

  describe("without hard links", () => {
    /** A fresh adapter whose `link` fails the way a volume without hard links does. */
    async function adapterWithoutHardLinks(): Promise<BrowserDownloadFiles> {
      vi.resetModules();
      vi.doMock("node:fs/promises", async (importOriginal) => {
        const actual =
          await importOriginal<typeof import("node:fs/promises")>();
        const refusing = {
          ...actual,
          link: async (from: string, to: string): Promise<void> => {
            linkProbe.calls.push({ from, to });
            throw Object.assign(new Error("operation not permitted"), {
              code: "EPERM",
            });
          },
        };
        return { ...refusing, default: refusing };
      });
      const fresh = await import("../browser-download-files");
      return fresh.nodeBrowserDownloadFiles;
    }

    it("copies to a free name and removes the held file", async () => {
      const held = write("Unconfirmed 4.traycer-download", "payload");
      const target = join(directory, "file.txt");
      const adapter = await adapterWithoutHardLinks();

      await expect(adapter.publish(held, target)).resolves.toBe("published");

      expect(linkProbe.calls).toEqual([{ from: held, to: target }]);
      expect(read(target)).toBe("payload");
      expect(existsSync(held)).toBe(false);
    });

    it("answers exists for a taken name, leaving its bytes and the held file intact", async () => {
      const held = write("Unconfirmed 5.traycer-download", "new bytes");
      const target = write("file.txt", "old bytes");
      const adapter = await adapterWithoutHardLinks();

      await expect(adapter.publish(held, target)).resolves.toBe("exists");

      expect(linkProbe.calls).toEqual([{ from: held, to: target }]);
      expect(read(target)).toBe("old bytes");
      expect(read(held)).toBe("new bytes");
    });
  });

  it("removes a missing path without throwing, sync and async", async () => {
    const missing = join(directory, "never-existed");

    await expect(
      nodeBrowserDownloadFiles.remove(missing),
    ).resolves.toBeUndefined();
    expect(nodeBrowserDownloadFiles.removeSync(missing)).toBeUndefined();
  });

  it("removes an existing file", async () => {
    const path = write("held.traycer-download", "x");
    await nodeBrowserDownloadFiles.remove(path);
    expect(existsSync(path)).toBe(false);

    const second = write("held2.traycer-download", "x");
    nodeBrowserDownloadFiles.removeSync(second);
    expect(existsSync(second)).toBe(false);
  });
  it("answers published when the held name cannot be removed afterwards", async () => {
    const held = write("Unconfirmed 6.traycer-download", "payload");
    const target = join(directory, "file.txt");
    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      const failing = {
        ...actual,
        rm: async (
          path: Parameters<typeof actual.rm>[0],
          options: Parameters<typeof actual.rm>[1],
        ): Promise<void> => {
          if (path === held) throw new Error("held name is busy");
          await actual.rm(path, options);
        },
      };
      return { ...failing, default: failing };
    });
    const fresh = await import("../browser-download-files");

    await expect(
      fresh.nodeBrowserDownloadFiles.publish(held, target),
    ).resolves.toBe("published");

    expect(read(target)).toBe("payload");
    // The removal really was refused: the held name is still there.
    expect(existsSync(held)).toBe(true);
  });
});
