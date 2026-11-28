import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorCode } from "./credentials-fs";

export type CliAuthMode = "interactive" | "managed" | "unreadable";

export async function readCliAuthMode(
  hostDataDir: string,
): Promise<CliAuthMode> {
  try {
    const marker = await readFile(join(hostDataDir, "cli-auth-mode"), "utf8");
    return marker === "managed\n" ? "managed" : "unreadable";
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "interactive" : "unreadable";
  }
}
