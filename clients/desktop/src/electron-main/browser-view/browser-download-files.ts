import { constants, rmSync } from "node:fs";
import { copyFile, link, rm } from "node:fs/promises";
import type { BrowserDownloadFiles } from "./browser-download";

/**
 * The real filesystem behind {@link BrowserDownloadFiles}.
 *
 * A finished download takes its own name through a hard link, then loses the
 * held one: `link` fails with `EEXIST` when anything is already at the
 * destination, which `rename` does not (it replaces the file there), and the
 * volume itself decides what "already there" means - so a name that differs
 * only by case, or by a composed against a decomposed character, on a volume
 * that treats them as one is refused too (measured on APFS). A volume with no
 * hard links (FAT and exFAT, some network shares) takes an exclusive copy
 * instead, which refuses an existing destination the same way.
 */
export const nodeBrowserDownloadFiles: BrowserDownloadFiles = {
  publish: async (from, to) => {
    try {
      await link(from, to);
    } catch (linkError) {
      if (errorCode(linkError) === "EEXIST") return "exists";
      try {
        await copyFile(from, to, constants.COPYFILE_EXCL);
      } catch (copyError) {
        if (errorCode(copyError) === "EEXIST") return "exists";
        throw copyError;
      }
    }
    await rm(from, { force: true });
    return "published";
  },
  remove: async (path) => {
    await rm(path, { force: true });
  },
  removeSync: (path) => {
    rmSync(path, { force: true });
  },
};

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  return typeof error.code === "string" ? error.code : null;
}
