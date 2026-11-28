import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorCode } from "./credentials-fs";

export type CliAuthMode = "interactive" | "managed" | "unreadable";

// A managed workspace call sends the host credential and any agent task
// capability to the loopback peer, using the ordinary agent path's loopback trust.
// Opting a shared computer into managed mode requires authenticated peer proof for both.
export async function readCliAuthMode(
  hostDataDir: string,
): Promise<CliAuthMode> {
  try {
    const marker = await readFile(join(hostDataDir, "cli-auth-mode"), "utf8");
    return marker === "managed\n" ? "managed" : "interactive";
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "interactive" : "unreadable";
  }
}
