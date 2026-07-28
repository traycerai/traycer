import { rememberRecentDocument } from "../app/recent-documents";
import {
  handleFlashFrame,
  handleSetBadge,
  handleSetContentProtection,
  handleSetDocumentEdited,
  handleSetOverlayIcon,
  handleSetProgressBar,
  handleSetRepresentedFilename,
  handleSetTitleBarOverlay,
} from "../app/window-effects";
import {
  handleGetMetrics,
  handleTakeHeapSnapshot,
  handleTraceStart,
  handleTraceStop,
} from "../app/diagnostics";
import {
  canPromptTouchID,
  getAccentColor,
  getEffectiveAppearance,
  handleSetBackgroundMaterial,
  handleSetVibrancy,
  handleSetVisibleOnAllWorkspaces,
  promptTouchID,
} from "../app/system-prefs";
import { readAccessibilityTheme } from "../app/resilience";
import { listInstalledFonts } from "../app/installed-fonts";
import {
  clearProxyCredentials,
  listKnownProxyCredentials,
  resolveProxyForUrl,
  saveProxyCredentials,
  setSessionProxy,
} from "../app/proxy-auth";
import {
  dismissPendingCertificateError,
  listPendingCertificateErrors,
  listTrustedCertificates,
  showSystemCertificateTrustDialog,
  trustCertificate,
  untrustCertificate,
} from "../app/cert-trust";
import { readDisplayTopology } from "../app/screen-monitor";
import { readNativeClipboardFilePaths } from "../clipboard/native-clipboard-file-paths";
import {
  getHardwareAccelerationPreference,
  setHardwareAccelerationPreference,
} from "../app/gpu-acceleration";
import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";
import type { FileSaveInput } from "../../ipc-contracts/platform-types";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  type ProxyConfig,
} from "electron";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";
import {
  getDesktopLogLevel,
  setDesktopLogLevel,
} from "../app/desktop-log-level";
import { readLogLevels, setLogLevels } from "@traycer/protocol/config/store";
import { isLogLevel, type LogLevel } from "@traycer/protocol/config/log-level";
import type {
  LogLevelScope,
  LogLevelsSnapshot,
} from "../../ipc-contracts/platform-types";

/**
 * Registers IPC handlers that expose platform-integration primitives to the
 * renderer: recent documents, window-attention effects (flash/progress/badge),
 * macOS document-window niceties (represented filename + dirty dot), screen
 * recording protection, and diagnostics (metrics / heap snapshot / tracing).
 *
 * All handlers are silent if the platform doesn't support them - the renderer
 * can call them unconditionally without platform-specific branches.
 */
export function registerPlatformIpc(bridge: RunnerIpcBridge): void {
  bridge.handleInvoke(
    RunnerHostInvoke.fileDropWriteTemporary,
    async (_event, input: unknown): Promise<string> => {
      const file = parseTemporaryDroppedFileInput(input);
      // Write under the OS temp dir, not `userData` - these are throwaway
      // copies of dragged-in documents. `temp` is OS-reclaimed, so a forgotten
      // file can't silently persist a user's private document across restarts.
      const directory = path.join(app.getPath("temp"), "traycer-dropped-files");
      await mkdir(directory, { recursive: true });
      const fileName = buildTemporaryDroppedFileName(file.name, file.type);
      const target = path.join(directory, fileName);
      await writeFile(target, Buffer.from(new Uint8Array(file.bytes)));
      return target;
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.fileDropCopyTemporary,
    async (_event, input: unknown): Promise<readonly string[]> => {
      const sourcePaths = parseCopyDroppedFileInput(input);
      if (sourcePaths.length === 0) return [];
      // Same OS-reclaimed scratch dir as `fileDropWriteTemporary`. Drops that
      // expose only a `file://` URL (the macOS screenshot thumbnail) point at an
      // ephemeral source the OS deletes shortly after the drag. Copy it now,
      // while it still exists, so the path pasted into the terminal stays valid
      // when the running program reads it.
      const directory = path.join(app.getPath("temp"), "traycer-dropped-files");
      await mkdir(directory, { recursive: true });
      return Promise.all(
        sourcePaths.map((sourcePath) =>
          copyDroppedFileToTemp(sourcePath, directory),
        ),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.fileDropReadNativeClipboardPaths,
    (): readonly string[] => {
      if (process.platform !== "darwin") return [];
      return readNativeClipboardFilePaths(clipboard);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.fileSave,
    async (event, input: unknown): Promise<string | null> => {
      const file = parseFileSaveInput(input);
      const defaultPath = path.basename(file.name) || "download";
      const options = {
        defaultPath,
        filters: buildSaveFileFilters(file.name, file.type),
      };
      const window = BrowserWindow.fromWebContents(event.sender);
      const result =
        window === null || window.isDestroyed()
          ? await dialog.showSaveDialog(options)
          : await dialog.showSaveDialog(window, options);
      if (result.canceled || !result.filePath) return null;
      await writeFile(result.filePath, Buffer.from(new Uint8Array(file.bytes)));
      return path.basename(result.filePath);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.recentDocumentAdd,
    (_event, path: unknown) => {
      if (typeof path === "string") {
        rememberRecentDocument(path);
      }
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.windowFlashFrame,
    (event, shouldFlash: unknown) => {
      handleFlashFrame(event, shouldFlash);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.windowSetProgressBar,
    (event, value: unknown) => {
      handleSetProgressBar(event, value);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.windowSetBadge,
    (event, text: unknown) => {
      handleSetBadge(event, text);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.windowSetRepresentedFilename,
    (event, path: unknown) => {
      handleSetRepresentedFilename(event, path);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.windowSetDocumentEdited,
    (event, edited: unknown) => {
      handleSetDocumentEdited(event, edited);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.windowSetContentProtection,
    (event, enabled: unknown) => {
      handleSetContentProtection(event, enabled);
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.diagnosticsGetMetrics, () => {
    return handleGetMetrics();
  });

  bridge.handleInvoke(RunnerHostInvoke.diagnosticsTakeHeapSnapshot, (event) => {
    return handleTakeHeapSnapshot(event);
  });

  bridge.handleInvoke(RunnerHostInvoke.diagnosticsTraceStart, () => {
    return handleTraceStart();
  });

  bridge.handleInvoke(RunnerHostInvoke.diagnosticsTraceStop, () => {
    return handleTraceStop();
  });

  bridge.handleInvoke(RunnerHostInvoke.systemPreferencesAccentColor, () => {
    return getAccentColor();
  });

  bridge.handleInvoke(RunnerHostInvoke.systemPreferencesAppearance, () => {
    return getEffectiveAppearance();
  });

  bridge.handleInvoke(
    RunnerHostInvoke.systemPreferencesAccessibilityTheme,
    () => readAccessibilityTheme(),
  );

  bridge.handleInvoke(RunnerHostInvoke.touchIdAvailable, () => {
    return canPromptTouchID();
  });

  bridge.handleInvoke(
    RunnerHostInvoke.touchIdPrompt,
    async (_event, reason: unknown) => {
      const reasonStr =
        typeof reason === "string" && reason.length > 0
          ? reason
          : "Authenticate to continue";
      return promptTouchID(reasonStr);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.windowSetVibrancy,
    (event, vibrancy: unknown) => {
      handleSetVibrancy(event, vibrancy);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.windowSetBackgroundMaterial,
    (event, material: unknown) => {
      handleSetBackgroundMaterial(event, material);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.windowSetVisibleOnAllWorkspaces,
    (event, visible: unknown) => {
      handleSetVisibleOnAllWorkspaces(event, visible);
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.proxyAuthList, () => {
    return listKnownProxyCredentials();
  });

  bridge.handleInvoke(
    RunnerHostInvoke.proxyAuthSave,
    async (
      _event,
      host: unknown,
      realm: unknown,
      username: unknown,
      password: unknown,
    ) => {
      if (
        typeof host !== "string" ||
        typeof realm !== "string" ||
        typeof username !== "string" ||
        typeof password !== "string"
      ) {
        throw new Error("proxyAuth:save requires string host/realm/user/pass");
      }
      return saveProxyCredentials(host, realm, username, password);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.proxyAuthClear,
    async (_event, host: unknown, realm: unknown) => {
      if (typeof host !== "string" || typeof realm !== "string") {
        throw new Error("proxyAuth:clear requires string host + realm");
      }
      await clearProxyCredentials(host, realm);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.proxySetConfig,
    async (_event, config: unknown) => {
      if (config === null || typeof config !== "object") {
        throw new Error("proxy:setConfig requires an object payload");
      }
      await setSessionProxy(config as ProxyConfig);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.proxyResolve,
    async (_event, url: unknown) => {
      if (typeof url !== "string") {
        throw new Error("proxy:resolve requires a string URL");
      }
      return resolveProxyForUrl(url);
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.certTrustList, () => {
    return listTrustedCertificates();
  });

  bridge.handleInvoke(
    RunnerHostInvoke.certTrustAdd,
    async (_event, hostname: unknown, certificate: unknown) => {
      if (typeof hostname !== "string") {
        throw new Error("cert:trust requires a string hostname");
      }
      // `Certificate` is a plain JSON-serializable object - accept any
      // shape and let `trustCertificate` validate via the fields it reads.
      return trustCertificate(hostname, certificate as Electron.Certificate);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.certTrustRemove,
    async (_event, fingerprint: unknown, hostname: unknown) => {
      if (typeof fingerprint !== "string" || typeof hostname !== "string") {
        throw new Error("cert:untrust requires string fingerprint + hostname");
      }
      await untrustCertificate(fingerprint, hostname);
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.certTrustListPending, () => {
    return listPendingCertificateErrors();
  });

  bridge.handleInvoke(
    RunnerHostInvoke.certTrustDismissPending,
    (_event, id: unknown) => {
      if (typeof id !== "string") return;
      dismissPendingCertificateError(id);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.certTrustSystemDialog,
    async (event, certificate: unknown, message: unknown) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window === null || window.isDestroyed()) return false;
      const msg = typeof message === "string" ? message : "";
      return showSystemCertificateTrustDialog(
        window,
        certificate as Electron.Certificate,
        msg,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.windowSetOverlayIcon,
    (event, image: unknown, description: unknown) => {
      handleSetOverlayIcon(event, image, description);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.windowSetTitleBarOverlay,
    (event, color: unknown, symbolColor: unknown) => {
      handleSetTitleBarOverlay(event, color, symbolColor);
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.displayList, () => {
    return readDisplayTopology();
  });

  bridge.handleInvoke(RunnerHostInvoke.gpuAccelerationGet, () => {
    return getHardwareAccelerationPreference();
  });

  bridge.handleInvoke(
    RunnerHostInvoke.gpuAccelerationSet,
    async (_event, enabled: unknown) => {
      return setHardwareAccelerationPreference(enabled !== false);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.logLevelsGet,
    (): Promise<LogLevelsSnapshot> => readLogLevelsSnapshot(),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.logLevelsSet,
    async (_event, input: unknown): Promise<LogLevelsSnapshot> => {
      const { scope, level } = parseLogLevelsSetInput(input);
      if (scope === "desktop") {
        await setDesktopLogLevel(level);
      } else {
        const levels = await readLogLevels();
        await setLogLevels(
          scope === "cli" ? level : levels.cliLogLevel,
          scope === "host" ? level : levels.hostLogLevel,
        );
      }
      return readLogLevelsSnapshot();
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.fontsList, () => {
    return listInstalledFonts();
  });
}

async function readLogLevelsSnapshot(): Promise<LogLevelsSnapshot> {
  const [levels, desktopLogLevel] = await Promise.all([
    readLogLevels(),
    getDesktopLogLevel(),
  ]);
  return {
    cliLogLevel: levels.cliLogLevel,
    hostLogLevel: levels.hostLogLevel,
    desktopLogLevel,
  };
}

function parseLogLevelsSetInput(input: unknown): {
  readonly scope: LogLevelScope;
  readonly level: LogLevel;
} {
  if (!isRecord(input)) {
    throw new Error("logLevels:set requires an object payload");
  }
  const scope = input.scope;
  if (scope !== "cli" && scope !== "host" && scope !== "desktop") {
    throw new Error("logLevels:set requires scope cli|host|desktop");
  }
  const level = input.level;
  if (!isLogLevel(level)) {
    throw new Error("logLevels:set requires a valid log level");
  }
  return { scope, level };
}

interface TemporaryDroppedFileInput {
  readonly name: string;
  readonly type: string;
  readonly bytes: ArrayBuffer;
}

function parseTemporaryDroppedFileInput(
  input: unknown,
): TemporaryDroppedFileInput {
  if (!isRecord(input)) {
    throw new Error("fileDrops.writeTemporary requires an object payload");
  }
  const name = input.name;
  if (typeof name !== "string") {
    throw new Error("fileDrops.writeTemporary requires a string name");
  }
  const type = input.type;
  if (typeof type !== "string") {
    throw new Error("fileDrops.writeTemporary requires a string type");
  }
  const bytes = input.bytes;
  if (!(bytes instanceof ArrayBuffer)) {
    throw new Error("fileDrops.writeTemporary requires ArrayBuffer bytes");
  }
  return { name, type, bytes };
}

function parseFileSaveInput(input: unknown): FileSaveInput {
  if (!isRecord(input)) {
    throw new Error("file.save requires an object payload");
  }
  const name = input.name;
  if (typeof name !== "string") {
    throw new Error("file.save requires a string name");
  }
  const type = input.type;
  if (typeof type !== "string") {
    throw new Error("file.save requires a string type");
  }
  const bytes = input.bytes;
  if (!(bytes instanceof ArrayBuffer)) {
    throw new Error("file.save requires ArrayBuffer bytes");
  }
  return { name, type, bytes };
}

function parseCopyDroppedFileInput(input: unknown): readonly string[] {
  if (!Array.isArray(input)) {
    throw new Error("fileDrops.copyTemporary requires an array of paths");
  }
  return input.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

async function copyDroppedFileToTemp(
  sourcePath: string,
  directory: string,
): Promise<string> {
  const fileName = buildTemporaryDroppedFileName(path.basename(sourcePath), "");
  const target = path.join(directory, fileName);
  try {
    await copyFile(sourcePath, target);
    return target;
  } catch {
    // The dragged file (e.g. a macOS screenshot thumbnail) may already have
    // been reclaimed by the OS. Fall back to the original path so the terminal
    // still receives a reference - no worse than not copying at all.
    return sourcePath;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildTemporaryDroppedFileName(name: string, type: string): string {
  const extension = droppedFileExtension(name, type);
  const parsed = path.parse(path.basename(name));
  const base = sanitizedDroppedFileBase(parsed.name);
  const stamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  return `${stamp}-${randomUUID()}-${base}${extension}`;
}

function droppedFileExtension(name: string, type: string): string {
  const ext = path.extname(name);
  if (ext.length > 0) return ext.slice(0, 24);
  if (type === "image/png") return ".png";
  if (type === "image/jpeg") return ".jpg";
  if (type === "image/gif") return ".gif";
  if (type === "image/webp") return ".webp";
  if (type === "application/pdf") return ".pdf";
  if (type === "text/plain") return ".txt";
  return ".bin";
}

function buildSaveFileFilters(
  name: string,
  type: string,
): Electron.FileFilter[] {
  const extension = droppedFileExtension(name, type).replace(/^\./, "");
  if (type === "image/png" || extension === "png") {
    return [{ name: "PNG image", extensions: ["png"] }];
  }
  if (type === "image/jpeg" || extension === "jpg" || extension === "jpeg") {
    return [{ name: "JPEG image", extensions: ["jpg", "jpeg"] }];
  }
  if (extension.length === 0) {
    return [{ name: "All Files", extensions: ["*"] }];
  }
  return [{ name: "File", extensions: [extension] }];
}

function sanitizedDroppedFileBase(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : "dropped-file";
}
