import { readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { LoginImportBrowser } from "@traycer-clients/shared/platform/browser-view";
import { MAX_LOGIN_IMPORT_FILE_BYTES, readBoundedFile } from "./bounded-file";
import type { ChromiumImportBrowser } from "./chromium-browsers";
import { errnoCode } from "./errno-code";

/**
 * Discovery of the cookie jars on this machine. Pure over `platform`,
 * `homeDir` and `env`, so one suite runs every OS layout against a fixture
 * tree on whatever CI runner it lands on.
 *
 * Nothing here opens a jar: discovery is `stat` and a `Local State` /
 * `profiles.ini` read, so it prompts for nothing and holds no cookie.
 */

export type LoginImportSourceLocation =
  | {
      readonly kind: "chromium";
      readonly browser: ChromiumImportBrowser;
      readonly cookiesPath: string;
      readonly localStatePath: string;
    }
  | { readonly kind: "firefox"; readonly cookiesPath: string }
  | { readonly kind: "safari"; readonly cookiesPath: string }
  | { readonly kind: "file"; readonly path: string };

export interface DiscoveredLoginImportSource {
  readonly browser: LoginImportBrowser;
  readonly profileLabel: string;
  readonly lastUsedAt: number | null;
  readonly location: LoginImportSourceLocation;
}

export interface LoginImportDiscoveryEnvironment {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Where an install came from, when a machine can hold more than one of the
 * same browser: on Linux a distribution package, a Flatpak and a Snap each
 * keep their own profiles, and two of them show the same `Default`. The
 * flavour is part of the label so the picker and the confirmation name one
 * install, not two indistinguishably.
 */
type BrowserInstall = "native" | "flatpak" | "snap";

interface ChromiumRoot {
  readonly browser: ChromiumImportBrowser;
  readonly userDataDir: string;
  readonly install: BrowserInstall;
  /** Opera keeps its one profile directly under the root, with no `Default`. */
  readonly profileless: boolean;
}

interface FirefoxRoot {
  readonly directory: string;
  readonly install: BrowserInstall;
}

/** `Default` for a packaged install, `Default (Flatpak)` for a Flatpak one. */
function labelForInstall(label: string, install: BrowserInstall): string {
  switch (install) {
    case "native":
      return label;
    case "flatpak":
      return `${label} (Flatpak)`;
    case "snap":
      return `${label} (Snap)`;
  }
}

const BROWSER_ORDER: readonly LoginImportBrowser[] = [
  "chrome",
  "edge",
  "brave",
  "arc",
  "vivaldi",
  "opera",
  "aside",
  "helium",
  "chromium",
  "firefox",
  "safari",
  "file",
];

export async function discoverLoginImportSources(
  environment: LoginImportDiscoveryEnvironment,
): Promise<readonly DiscoveredLoginImportSource[]> {
  const found = await Promise.all([
    ...chromiumRoots(environment).map((root) => discoverChromiumProfiles(root)),
    ...firefoxRoots(environment).map((root) => discoverFirefoxProfiles(root)),
    discoverSafari(environment),
  ]);
  return found.flat().sort(compareSources);
}

/** The picked-file source; the file itself is read only at scan and import. */
export async function describeCookieFileSource(
  path: string,
): Promise<DiscoveredLoginImportSource> {
  const mtime = await statMtime(path);
  return {
    browser: "file",
    profileLabel: basename(path),
    lastUsedAt: mtime.kind === "found" ? mtime.mtimeMs : null,
    location: { kind: "file", path },
  };
}

function compareSources(
  left: DiscoveredLoginImportSource,
  right: DiscoveredLoginImportSource,
): number {
  if (left.lastUsedAt !== right.lastUsedAt) {
    if (left.lastUsedAt === null) return 1;
    if (right.lastUsedAt === null) return -1;
    return right.lastUsedAt - left.lastUsedAt;
  }
  const byBrowser =
    BROWSER_ORDER.indexOf(left.browser) - BROWSER_ORDER.indexOf(right.browser);
  if (byBrowser !== 0) return byBrowser;
  return left.profileLabel.localeCompare(right.profileLabel);
}

// --- Chromium family -------------------------------------------------------

function chromiumRoots(
  environment: LoginImportDiscoveryEnvironment,
): readonly ChromiumRoot[] {
  const home = environment.homeDir;
  if (environment.platform === "darwin") {
    const support = join(home, "Library", "Application Support");
    return [
      root("chrome", join(support, "Google", "Chrome")),
      root("chromium", join(support, "Chromium")),
      root("edge", join(support, "Microsoft Edge")),
      root("brave", join(support, "BraveSoftware", "Brave-Browser")),
      root("arc", join(support, "Arc", "User Data")),
      root("vivaldi", join(support, "Vivaldi")),
      profilelessRoot("opera", join(support, "com.operasoftware.Opera")),
      // Aside and Helium ship macOS builds only as far as this list has
      // verified; their Windows and Linux roots are not listed below.
      root("aside", join(support, "Aside")),
      root("helium", join(support, "net.imput.helium")),
    ];
  }
  if (environment.platform === "win32") {
    const local =
      environment.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const roaming = environment.env.APPDATA ?? join(home, "AppData", "Roaming");
    return [
      root("chrome", join(local, "Google", "Chrome", "User Data")),
      root("chromium", join(local, "Chromium", "User Data")),
      root("edge", join(local, "Microsoft", "Edge", "User Data")),
      root("brave", join(local, "BraveSoftware", "Brave-Browser", "User Data")),
      root("vivaldi", join(local, "Vivaldi", "User Data")),
      profilelessRoot("opera", join(roaming, "Opera Software", "Opera Stable")),
    ];
  }
  const config = environment.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return [
    root("chrome", join(config, "google-chrome")),
    packagedRoot(
      "chrome",
      join(home, ".var", "app", "com.google.Chrome", "config", "google-chrome"),
      "flatpak",
    ),
    root("chromium", join(config, "chromium")),
    packagedRoot(
      "chromium",
      join(home, "snap", "chromium", "common", "chromium"),
      "snap",
    ),
    root("edge", join(config, "microsoft-edge")),
    root("brave", join(config, "BraveSoftware", "Brave-Browser")),
    packagedRoot(
      "brave",
      join(
        home,
        ".var",
        "app",
        "com.brave.Browser",
        "config",
        "BraveSoftware",
        "Brave-Browser",
      ),
      "flatpak",
    ),
    root("vivaldi", join(config, "vivaldi")),
    profilelessRoot("opera", join(config, "opera")),
  ];
}

function root(
  browser: ChromiumImportBrowser,
  userDataDir: string,
): ChromiumRoot {
  return { browser, userDataDir, install: "native", profileless: false };
}

function packagedRoot(
  browser: ChromiumImportBrowser,
  userDataDir: string,
  install: BrowserInstall,
): ChromiumRoot {
  return { browser, userDataDir, install, profileless: false };
}

function profilelessRoot(
  browser: ChromiumImportBrowser,
  userDataDir: string,
): ChromiumRoot {
  return { browser, userDataDir, install: "native", profileless: true };
}

const localStateSchema = z.object({
  profile: z
    .object({
      info_cache: z.record(
        z.string(),
        z.object({ name: z.string().nullable().catch(null) }).catch({
          name: null,
        }),
      ),
    })
    .nullable()
    .catch(null),
});

async function discoverChromiumProfiles(
  chromiumRoot: ChromiumRoot,
): Promise<readonly DiscoveredLoginImportSource[]> {
  const localStatePath = join(chromiumRoot.userDataDir, "Local State");
  if (chromiumRoot.profileless) {
    const jar = await newestCookieDatabase(chromiumRoot.userDataDir);
    if (jar === null) return [];
    return [
      {
        browser: chromiumRoot.browser,
        profileLabel: labelForInstall("Default", chromiumRoot.install),
        lastUsedAt: jar.mtimeMs,
        location: {
          kind: "chromium",
          browser: chromiumRoot.browser,
          cookiesPath: jar.path,
          localStatePath,
        },
      },
    ];
  }
  const profiles = await chromiumProfileDirectories(
    chromiumRoot.userDataDir,
    localStatePath,
  );
  const sources = await Promise.all(
    profiles.map(
      async (profile): Promise<DiscoveredLoginImportSource | null> => {
        const jar = await newestCookieDatabase(
          join(chromiumRoot.userDataDir, profile.directory),
        );
        if (jar === null) return null;
        return {
          browser: chromiumRoot.browser,
          profileLabel: labelForInstall(profile.label, chromiumRoot.install),
          lastUsedAt: jar.mtimeMs,
          location: {
            kind: "chromium",
            browser: chromiumRoot.browser,
            cookiesPath: jar.path,
            localStatePath,
          },
        };
      },
    ),
  );
  return sources.filter((source) => source !== null);
}

/**
 * The profile directories under a User Data root, labelled from
 * `Local State`'s `profile.info_cache` when it can be read, and from the
 * directory names (`Default`, `Profile N`) when it cannot.
 */
async function chromiumProfileDirectories(
  userDataDir: string,
  localStatePath: string,
): Promise<readonly { readonly directory: string; readonly label: string }[]> {
  const localState = await readJson(localStatePath, localStateSchema);
  const infoCache = localState?.profile?.info_cache ?? null;
  // A key names a directory DIRECTLY under the root, and the file is on disk
  // for anyone to edit: one with a separator or a dot segment would join to
  // a path outside User Data and point discovery at any Cookies file on the
  // machine, so it is dropped, whatever the file says.
  const cached =
    infoCache === null
      ? []
      : Object.entries(infoCache).filter(([directory]) =>
          isPlainDirectoryName(directory),
        );
  if (cached.length > 0) {
    return disambiguateLabels(
      cached.map(([directory, info]) => ({
        directory,
        label:
          info.name !== null && info.name.length > 0 ? info.name : directory,
      })),
    );
  }
  const entries = await readdirQuietly(userDataDir);
  return entries
    .filter((entry) => entry === "Default" || /^Profile \d+$/u.test(entry))
    .map((directory) => ({ directory, label: directory }));
}

/** One path segment: no separator of either platform, no NUL, not a dot entry. */
function isPlainDirectoryName(name: string): boolean {
  return (
    name.length > 0 && name !== "." && name !== ".." && !/[\\/\0]/u.test(name)
  );
}

/**
 * Two profiles can share a display name (Chrome lets a person name each
 * profile after themselves); the directory is what tells them apart in the
 * picker, and it is appended only when it has to be.
 */
function disambiguateLabels(
  profiles: readonly { readonly directory: string; readonly label: string }[],
): readonly { readonly directory: string; readonly label: string }[] {
  const occurrences = new Map<string, number>();
  for (const profile of profiles) {
    occurrences.set(profile.label, (occurrences.get(profile.label) ?? 0) + 1);
  }
  return profiles.map((profile) =>
    (occurrences.get(profile.label) ?? 0) > 1
      ? { ...profile, label: `${profile.label} (${profile.directory})` }
      : profile,
  );
}

/**
 * The cookie DB is `Cookies` or `Network/Cookies` under the profile, by
 * Chromium era and platform; when both exist the newer one is the live jar.
 */
async function newestCookieDatabase(
  profileDir: string,
): Promise<{ readonly path: string; readonly mtimeMs: number } | null> {
  const candidates = [
    join(profileDir, "Cookies"),
    join(profileDir, "Network", "Cookies"),
  ];
  let newest: { readonly path: string; readonly mtimeMs: number } | null = null;
  for (const path of candidates) {
    const mtime = await statMtime(path);
    if (mtime.kind !== "found") continue;
    if (newest === null || mtime.mtimeMs > newest.mtimeMs) {
      newest = { path, mtimeMs: mtime.mtimeMs };
    }
  }
  return newest;
}

// --- Firefox ---------------------------------------------------------------

function firefoxRoots(
  environment: LoginImportDiscoveryEnvironment,
): readonly FirefoxRoot[] {
  const home = environment.homeDir;
  if (environment.platform === "darwin") {
    return [
      {
        directory: join(home, "Library", "Application Support", "Firefox"),
        install: "native",
      },
    ];
  }
  if (environment.platform === "win32") {
    const roaming = environment.env.APPDATA ?? join(home, "AppData", "Roaming");
    return [
      { directory: join(roaming, "Mozilla", "Firefox"), install: "native" },
    ];
  }
  return [
    { directory: join(home, ".mozilla", "firefox"), install: "native" },
    {
      directory: join(home, "snap", "firefox", "common", ".mozilla", "firefox"),
      install: "snap",
    },
    {
      directory: join(
        home,
        ".var",
        "app",
        "org.mozilla.firefox",
        ".mozilla",
        "firefox",
      ),
      install: "flatpak",
    },
  ];
}

async function discoverFirefoxProfiles(
  firefoxRoot: FirefoxRoot,
): Promise<readonly DiscoveredLoginImportSource[]> {
  const ini = await readTextQuietly(
    join(firefoxRoot.directory, "profiles.ini"),
  );
  if (ini === null) return [];
  const sources = await Promise.all(
    parseFirefoxProfilesIni(ini).map(
      async (profile): Promise<DiscoveredLoginImportSource | null> => {
        const profileDir = profile.isRelative
          ? join(firefoxRoot.directory, profile.path)
          : profile.path;
        const cookiesPath = join(profileDir, "cookies.sqlite");
        const mtime = await statMtime(cookiesPath);
        if (mtime.kind !== "found") return null;
        return {
          browser: "firefox",
          profileLabel: labelForInstall(profile.name, firefoxRoot.install),
          lastUsedAt: mtime.mtimeMs,
          location: { kind: "firefox", cookiesPath },
        };
      },
    ),
  );
  return sources.filter((source) => source !== null);
}

interface FirefoxProfile {
  readonly name: string;
  readonly path: string;
  readonly isRelative: boolean;
}

/** `[ProfileN]` sections of `profiles.ini`; `[Install…]` and `[General]` are skipped. */
export function parseFirefoxProfilesIni(
  text: string,
): readonly FirefoxProfile[] {
  const profiles: FirefoxProfile[] = [];
  let section: Record<string, string> | null = null;
  const flush = (): void => {
    if (section === null) return;
    const path = section.Path;
    if (path !== undefined && path.length > 0) {
      profiles.push({
        // The name becomes the picker's label, which crosses to the renderer.
        // Without one - absent OR a bare `Name=`, which the ini parser reads
        // as "" - the LAST segment stands in, never the path itself, which
        // for `IsRelative=0` is absolute and starts at the home dir.
        name:
          section.Name !== undefined && section.Name.length > 0
            ? section.Name
            : profileDirectoryName(path),
        path,
        isRelative: section.IsRelative !== "0",
      });
    }
    section = null;
  };
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      flush();
      section = /^\[Profile\d+\]$/u.test(line) ? {} : null;
      continue;
    }
    if (section === null) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    section[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  flush();
  return profiles;
}

/**
 * The last segment of a `profiles.ini` path, whichever separator wrote it:
 * an absolute `Path` on Windows carries backslashes even when this code runs
 * elsewhere, so `node:path`'s platform basename would keep the whole thing.
 */
function profileDirectoryName(path: string): string {
  const segments = path.split(/[\\/]+/u).filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? "Profile";
}

// --- Safari ----------------------------------------------------------------

async function discoverSafari(
  environment: LoginImportDiscoveryEnvironment,
): Promise<readonly DiscoveredLoginImportSource[]> {
  if (environment.platform !== "darwin") return [];
  const candidates = [
    join(
      environment.homeDir,
      "Library",
      "Containers",
      "com.apple.Safari",
      "Data",
      "Library",
      "Cookies",
      "Cookies.binarycookies",
    ),
    join(environment.homeDir, "Library", "Cookies", "Cookies.binarycookies"),
  ];
  for (const cookiesPath of candidates) {
    const mtime = await statMtime(cookiesPath);
    // Without Full Disk Access the container answers EPERM, not ENOENT. The
    // jar is there; listing it is what lets the scan explain the grant.
    if (mtime.kind === "missing") continue;
    return [
      {
        browser: "safari",
        profileLabel: "Safari",
        lastUsedAt: mtime.kind === "found" ? mtime.mtimeMs : null,
        location: { kind: "safari", cookiesPath },
      },
    ];
  }
  return [];
}

// --- Filesystem helpers ----------------------------------------------------

type MtimeResult =
  | { readonly kind: "found"; readonly mtimeMs: number }
  | { readonly kind: "denied" }
  | { readonly kind: "missing" };

async function statMtime(path: string): Promise<MtimeResult> {
  try {
    const info = await stat(path);
    return info.isFile()
      ? { kind: "found", mtimeMs: info.mtimeMs }
      : { kind: "missing" };
  } catch (error) {
    const code = errnoCode(error);
    return code === "EPERM" || code === "EACCES"
      ? { kind: "denied" }
      : { kind: "missing" };
  }
}

/**
 * Bounded like every other file read of the import: a `Local State` or
 * `profiles.ini` is kilobytes, and one that is not is not read into main.
 */
async function readTextQuietly(path: string): Promise<string | null> {
  const file = await readBoundedFile(path, MAX_LOGIN_IMPORT_FILE_BYTES);
  return file.ok ? file.bytes.toString("utf8") : null;
}

async function readdirQuietly(path: string): Promise<readonly string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function readJson<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const text = await readTextQuietly(path);
  if (text === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A picked path must be absolute and resolved: no relative segments survive. */
export function normalizePickedFilePath(path: string): string | null {
  if (!isAbsolute(path)) return null;
  return resolve(path);
}
