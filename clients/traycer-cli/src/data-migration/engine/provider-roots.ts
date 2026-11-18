import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DataRootPlatform } from "@traycer/protocol/config/data-root";
import { isErrnoException } from "../../runner/errors";
import { pathInsideRoot } from "../external-actions/ledger";
import { EngineStop, engineBlocker } from "./engine-types";

/**
 * The managed provider-profile folders inside a source root: the folders
 * holding provider-native bytes (transcripts, sidecars, credentials of a
 * managed account) whose destination copies cleanup must find intact before it
 * may delete the source backup.
 *
 * Two sources, unioned, per host slot home (`host`, `host/staging`,
 * `host/dev`, `host/dev-runs/<slot>`, `host/dev/identities/<name>`):
 * - every `managed` profile's `dirPath` in `config/provider-accounts.json`
 *   that lies inside the root (the host's own record of where each managed
 *   account lives; `domain/providers/profile-store.ts`);
 * - every profile folder actually present under `harness-accounts/<provider>/`
 *   (`managedProfileDirPath`), including one a record no longer names.
 *
 * A provider-accounts record that cannot be read refuses: the preservation
 * evidence would otherwise silently miss a managed account.
 */

async function children(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (
      isErrnoException(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return [];
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch (error) {
    if (
      isErrnoException(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return false;
    throw error;
  }
}

export async function hostSlotHomes(
  sourceRoot: string,
): Promise<readonly string[]> {
  const host = join(sourceRoot, "host");
  const candidates = [host, join(host, "staging"), join(host, "dev")];
  for (const slot of await children(join(host, "dev-runs")))
    candidates.push(join(host, "dev-runs", slot));
  for (const name of await children(join(host, "dev", "identities")))
    candidates.push(join(host, "dev", "identities", name));
  const slots: string[] = [];
  for (const candidate of candidates)
    if (await isDirectory(candidate)) slots.push(candidate);
  return slots;
}

function toRelative(
  path: string,
  root: string,
  platform: DataRootPlatform,
): string | null {
  const relative = pathInsideRoot(path, root, platform);
  if (relative === null || relative.length === 0) return null;
  return relative.split(/[\\/]/u).join("/");
}

async function recordedManagedDirs(slot: string): Promise<readonly string[]> {
  const recordPath = join(slot, "config", "provider-accounts.json");
  let raw: string;
  try {
    raw = await readFile(recordPath, "utf8");
  } catch (error) {
    if (
      isErrnoException(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return [];
    throw error;
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    document = null;
  }
  const profiles =
    typeof document === "object" && document !== null
      ? Reflect.get(document, "profiles")
      : null;
  if (!Array.isArray(profiles)) {
    throw new EngineStop(
      "blocked",
      [
        engineBlocker(
          "provider-accounts-unreadable",
          recordPath,
          "a provider accounts record cannot be read",
        ),
      ],
      null,
    );
  }
  const dirs: string[] = [];
  for (const profile of profiles) {
    if (typeof profile !== "object" || profile === null) continue;
    if (Reflect.get(profile, "kind") !== "managed") continue;
    const dirPath = Reflect.get(profile, "dirPath");
    if (typeof dirPath === "string") dirs.push(dirPath);
  }
  return dirs;
}

/** Root-relative managed provider-profile folders, sorted and deduplicated. */
export async function managedProviderRoots(input: {
  readonly sourceRoot: string;
  readonly platform: DataRootPlatform;
}): Promise<readonly string[]> {
  const roots = new Set<string>();
  for (const slot of await hostSlotHomes(input.sourceRoot)) {
    for (const dir of await recordedManagedDirs(slot)) {
      const relative = toRelative(dir, input.sourceRoot, input.platform);
      if (relative !== null) roots.add(relative);
    }
    const accounts = join(slot, "harness-accounts");
    for (const provider of await children(accounts)) {
      for (const profile of await children(join(accounts, provider))) {
        const dir = join(accounts, provider, profile);
        if (!(await isDirectory(dir))) continue;
        const relative = toRelative(dir, input.sourceRoot, input.platform);
        if (relative !== null) roots.add(relative);
      }
    }
  }
  return [...roots].sort();
}

/** Whether a root-relative inventory path lies in one of `providerRoots`. */
export function isProviderPath(
  path: string,
  providerRoots: readonly string[],
  platform: DataRootPlatform,
): boolean {
  const fold = (value: string): string =>
    platform === "win32" ? value.toLowerCase() : value;
  const candidate = fold(path);
  return providerRoots.some(
    (root) =>
      candidate === fold(root) || candidate.startsWith(`${fold(root)}/`),
  );
}
