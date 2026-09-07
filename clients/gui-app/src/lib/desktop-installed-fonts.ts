/**
 * Feature-detected access to the desktop-only `platform.fonts` namespace the Electron preload installs on `window.runnerHost`. gui-app stays browser-safe, so this reads the global defensively and returns `null` on shells (web / gui-app-dev) that don't expose.
 */

export interface InstalledFont {
  readonly family: string;
}

export interface InstalledFontsBridge {
  readonly list: () => Promise<readonly InstalledFont[]>;
}

interface RunnerHostWindowShape {
  readonly platform:
    | { readonly fonts: InstalledFontsBridge | undefined }
    | undefined;
}

export function getInstalledFontsBridge(): InstalledFontsBridge | null {
  const host = (globalThis as { runnerHost?: RunnerHostWindowShape })
    .runnerHost;
  return host?.platform?.fonts ?? null;
}
