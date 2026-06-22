import { app } from "electron";
import { log } from "./logger";

/**
 * Registers `path` with the OS recent-documents surface - appears in
 * macOS dock right-click "Recent" and Windows jumplist "Recent" group.
 * No-op on Linux (no native surface). `path` should be an absolute path
 * to the artifact backing the epic (workspace dir is the natural choice).
 */
export function rememberRecentDocument(path: string): void {
  if (typeof path !== "string" || path.length === 0) return;
  if (process.platform === "linux") return;
  app.addRecentDocument(path);
}

/**
 * Windows-only: populate the jumplist's "Tasks" group (right-click on
 * the taskbar icon). These shortcuts launch the app with an argument
 * the renderer can interpret to deep-link into a specific surface.
 * Pairs with `configureAppUserModelId` - the AUMID must match for the
 * jumplist to bind to the running app.
 */
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
