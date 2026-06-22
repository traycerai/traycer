import {
  basename as patheBasename,
  dirname as patheDirname,
  isAbsolute as patheIsAbsolute,
  normalize as patheNormalize,
} from "pathe";

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:(?:\/|$)/;
const WINDOWS_UNC_PATH_PATTERN = /^\/\/[^/]+\/[^/]+/;

export function normalizePath(path: string): string {
  return patheNormalize(path);
}

export function getBasename(path: string): string {
  return patheBasename(path);
}

export function getDirname(path: string): string {
  const directory = patheDirname(path);
  return directory === "." ? "" : directory;
}

export function isAbsolutePath(path: string): boolean {
  return patheIsAbsolute(path);
}

export function pathComparisonKey(
  path: string,
  caseInsensitive: boolean,
): string {
  const normalized = normalizePath(path);
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

export function isWindowsLikePath(path: string): boolean {
  const normalized = normalizePath(path);
  return (
    WINDOWS_DRIVE_PATH_PATTERN.test(normalized) ||
    WINDOWS_UNC_PATH_PATTERN.test(normalized)
  );
}
