import { readFileSync } from "node:fs";
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
    return classifyMarker(await readFile(markerPath(hostDataDir), "utf8"));
  } catch (error) {
    return classifyMarkerError(error);
  }
}

/** CLI mode selection must precede the personal path's first await. */
export function readCliAuthModeSync(hostDataDir: string): CliAuthMode {
  try {
    return classifyMarker(readFileSync(markerPath(hostDataDir), "utf8"));
  } catch (error) {
    return classifyMarkerError(error);
  }
}

function markerPath(hostDataDir: string): string {
  return join(hostDataDir, "cli-auth-mode");
}

function classifyMarker(marker: string): CliAuthMode {
  return marker === "managed\n" ? "managed" : "interactive";
}

function classifyMarkerError(error: unknown): CliAuthMode {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR" ? "interactive" : "unreadable";
}
