import { app } from "electron";
import { log } from "./logger";

export function rememberRecentDocument(path: string): void {
  if (typeof path !== "string" || path.length === 0) return;
  if (process.platform === "linux") return;
  app.addRecentDocument(path);
}

/** Pairs with `configureAppUserModelId` - the AUMID must match for the jumplist to bind to the running app. */
export function installWindowsJumplistTasks(): void {
  if (process.platform !== "win32") return;
  const exe = process.execPath;
  app.setUserTasks([
    {
      program: exe,
      arguments: "--new-epic",
      iconPath: exe,
      iconIndex: 0,
      title: "New Epic",
      description: "Open a new Traycer epic window",
    },
    {
      program: exe,
      arguments: "--open-settings",
      iconPath: exe,
      iconIndex: 0,
      title: "Settings",
      description: "Open Traycer settings",
    },
  ]);
  log.info("[recent-documents] windows jumplist installed");
}
