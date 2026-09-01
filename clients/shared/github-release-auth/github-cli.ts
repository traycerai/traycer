import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { stripGitHubReleaseCredentialsFromEnv } from "./host-env";
import { trimSecret } from "./redact";

const execFileAsync = promisify(execFile);

export async function readGitHubCliToken(
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const executable = await resolveGhExecutable(env);
  if (executable === null) return null;
  try {
    const result = await execFileAsync(
      executable,
      ["auth", "token", "--hostname", "github.com"],
      {
        encoding: "utf8",
        env: stripGitHubReleaseCredentialsFromEnv(env),
        timeout: 8_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
    );
    const token = trimSecret(result.stdout);
    return token.length === 0 ? null : token;
  } catch {
    // Command output may contain credential material; never put it in an error.
    return null;
  }
}

export async function resolveGhExecutable(
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const executableName = process.platform === "win32" ? "gh.exe" : "gh";
  const candidates = [
    ...wellKnownGhPaths(env),
    ...pathDirectories(env).map((dir) => join(dir, executableName)),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const validated = await validateGhExecutable(candidate);
    if (validated !== null) return validated;
  }
  return null;
}

async function validateGhExecutable(candidate: string): Promise<string | null> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return null;
    await access(candidate, constants.F_OK);
    if (process.platform !== "win32") {
      await access(candidate, constants.X_OK);
    }
    return realpath(candidate);
  } catch {
    return null;
  }
}

function pathDirectories(env: NodeJS.ProcessEnv): readonly string[] {
  const value = env.PATH ?? env.Path ?? "";
  return value.split(delimiter).filter((entry) => entry.length > 0);
}

function wellKnownGhPaths(env: NodeJS.ProcessEnv): readonly string[] {
  const home = homedir();
  if (process.platform === "darwin") {
    return [
      "/opt/homebrew/bin/gh",
      "/usr/local/bin/gh",
      "/usr/bin/gh",
      join(home, ".local", "bin", "gh"),
    ];
  }
  if (process.platform === "linux") {
    return [
      "/usr/bin/gh",
      "/usr/local/bin/gh",
      "/snap/bin/gh",
      "/home/linuxbrew/.linuxbrew/bin/gh",
      join(home, ".local", "bin", "gh"),
    ];
  }
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  return [
    join(programFiles, "GitHub CLI", "gh.exe"),
    join(localAppData, "Programs", "GitHub CLI", "gh.exe"),
    join(home, "scoop", "shims", "gh.exe"),
  ];
}
