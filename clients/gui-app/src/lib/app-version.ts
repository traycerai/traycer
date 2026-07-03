import packageJson from "../../package.json";

export function getClientAppVersion(): string | null {
  const raw = import.meta.env.VITE_APP_VERSION;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  return null;
}

export function getClientAppVersionLabel(): string {
  const raw = getClientAppVersion() ?? packageJson.version;
  return raw.startsWith("v") ? raw : `v${raw}`;
}
