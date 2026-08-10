import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../app/logger";

export interface ProfilesRecoveryWebContents {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

/**
 * One-shot recovery after the appName rename moved Electron userData.
 * Profiles lived in the previous userData Local Storage; we extracted them to
 * this recovery folder and re-inject into renderer localStorage once.
 */
const RECOVERY_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "Thanos-Traycer-Recovery",
);
const PROFILES_FILE = join(RECOVERY_DIR, "project-profiles.json");
const ACTIVE_FILE = join(RECOVERY_DIR, "active-project-profile.json");
const MARKER_FILE = join(RECOVERY_DIR, "injected.ok");

const DEFAULT_EMAILS = ["gavasques@gmail.com", "anon"] as const;

export async function maybeInjectRecoveredProjectProfiles(
  webContents: ProfilesRecoveryWebContents,
): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  if (!existsSync(PROFILES_FILE) || existsSync(MARKER_FILE)) return false;

  let profilesJson: string;
  let activeJson: string;
  try {
    profilesJson = readFileSync(PROFILES_FILE, "utf-8");
    JSON.parse(profilesJson);
    activeJson = existsSync(ACTIVE_FILE)
      ? readFileSync(ACTIVE_FILE, "utf-8")
      : '{"state":{"activeProfileId":null},"version":1}';
    JSON.parse(activeJson);
  } catch (err) {
    log.warn("[profiles-recovery] invalid recovery payload", err);
    return false;
  }

  const emailsJson = JSON.stringify([...DEFAULT_EMAILS]);
  const script = `(() => {
    const profiles = ${JSON.stringify(profilesJson)};
    const active = ${JSON.stringify(activeJson)};
    const emails = new Set(${emailsJson});
    for (const key of Object.keys(localStorage)) {
      const m = /^traycer-gui-app:project-profiles:(.+)$/.exec(key);
      if (m) emails.add(m[1]);
      const a = /^traycer-gui-app:active-project-profile:(.+)$/.exec(key);
      if (a) emails.add(a[1]);
    }
    try {
      const authRaw = localStorage.getItem("traycer-gui-app:auth");
      if (authRaw) {
        const auth = JSON.parse(authRaw);
        const email = auth?.state?.user?.email;
        if (typeof email === "string" && email.includes("@")) emails.add(email);
      }
    } catch {}
    const written = [];
    for (const email of emails) {
      localStorage.setItem("traycer-gui-app:project-profiles:" + email, profiles);
      localStorage.setItem("traycer-gui-app:active-project-profile:" + email, active);
      written.push(email);
    }
    return written;
  })()`;

  try {
    const written = (await webContents.executeJavaScript(script, true)) as
      | string[]
      | undefined;
    writeFileSync(MARKER_FILE, new Date().toISOString() + "\n", "utf-8");
    log.info("[profiles-recovery] reinjected project profiles", {
      emails: written ?? [],
    });
    return true;
  } catch (err) {
    log.warn("[profiles-recovery] inject failed", err);
    return false;
  }
}
