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
import type {
  FileSaveInput,
  FileSaveResult,
} from "../../ipc-contracts/platform-types";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  nativeImage,
  shell,
  type ProxyConfig,
} from "electron";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isClipboardImageMediaType,
  type ClipboardImageMediaType,
} from "@traycer-clients/shared/images/clipboard-image-media";
import { MAX_ARTIFACT_IMAGE_BYTES } from "@traycer/protocol/host/epic/unary-schemas";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";
import {
  getDesktopLogLevel,
  setDesktopLogLevel,
} from "../app/desktop-log-level";
import {
  readFeatureSettings,
  readLogLevels,
  setAgentRolesEnabled,
  setLogLevels,
} from "@traycer/protocol/config/store";
import { isLogLevel, type LogLevel } from "@traycer/protocol/config/log-level";
import type {
  LogLevelScope,
  LogLevelsSnapshot,
  FeatureSettingsSnapshot,
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
export function registerPlatformIpc(
  bridge: Pick<RunnerIpcBridge, "handleInvoke">,
): void {
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

  // Every path `fileSave` wrote this process lifetime. `fileOpenSaved` opens
  // only members of this set, so the renderer's "Open file" affordance can
  // reach exactly the files the user just picked in the native dialog and
  // nothing else on disk.
  const savedFilePaths = new Set<string>();

  bridge.handleInvoke(
    RunnerHostInvoke.fileSave,
    async (event, input: unknown): Promise<FileSaveResult | null> => {
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
      savedFilePaths.add(result.filePath);
      return { name: path.basename(result.filePath), path: result.filePath };
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.fileOpenSaved,
    async (_event, input: unknown): Promise<void> => {
      if (typeof input !== "string" || !savedFilePaths.has(input)) {
        throw new Error("file.openSaved: path was not saved by this session");
      }
      // `shell.openPath` resolves to "" on success and to an OS error message
      // on failure (file gone, no handler app) - surface that as a rejection
      // so the renderer can toast it instead of silently doing nothing.
      const failure = await shell.openPath(input);
      if (failure.length > 0) {
        throw new Error(failure);
      }
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.clipboardWriteImage,
    (_event, input: unknown): void => {
      const image = parseClipboardImageInput(input);
      const native = nativeImage.createFromBuffer(
        Buffer.from(new Uint8Array(image.bytes)),
      );
      const size = native.getSize();
      if (
        native.isEmpty() ||
        size.width <= 0 ||
        size.height <= 0 ||
        size.width > MAX_CLIPBOARD_IMAGE_PIXELS / size.height
      ) {
        throw new Error("clipboard image bytes are invalid");
      }
      clipboard.writeImage(native);
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

  bridge.handleInvoke(
    RunnerHostInvoke.featureSettingsGet,
    (): Promise<FeatureSettingsSnapshot> => readFeatureSettings(),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.agentRolesEnabledSet,
    async (_event, enabled: unknown): Promise<FeatureSettingsSnapshot> => {
      if (typeof enabled !== "boolean") {
        throw new Error("featureSettings:agentRoles:set requires a boolean");
      }
      await setAgentRolesEnabled(enabled);
      return readFeatureSettings();
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

interface ClipboardImageInput {
  // Advisory caller metadata; Electron validates the actual bytes below.
  readonly type: ClipboardImageMediaType;
  readonly bytes: ArrayBuffer;
}

const MAX_CLIPBOARD_IMAGE_PIXELS = 64_000_000;

function parseClipboardImageInput(input: unknown): ClipboardImageInput {
  if (!isRecord(input)) {
    throw new Error("clipboard.writeImage requires an object payload");
  }
  const type = clipboardImageMediaType(input.type);
  if (type === null) {
    throw new Error("clipboard.writeImage requires an image MIME type");
  }
  const bytes = input.bytes;
  if (
    !(bytes instanceof ArrayBuffer) ||
    bytes.byteLength > MAX_ARTIFACT_IMAGE_BYTES
  ) {
    throw new Error("clipboard.writeImage requires image bytes under 30 MB");
  }
  assertClipboardImageDimensions(type, bytes);
  return { type, bytes };
}

function assertClipboardImageDimensions(
  type: ClipboardImageMediaType,
  bytes: ArrayBuffer,
): void {
  const dimensions =
    type === "image/png" ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (
    dimensions === null ||
    dimensions[0] <= 0 ||
    dimensions[1] <= 0 ||
    dimensions[0] > MAX_CLIPBOARD_IMAGE_PIXELS / dimensions[1]
  ) {
    throw new Error("clipboard image bytes are invalid");
  }
}

function pngDimensions(bytes: ArrayBuffer): readonly [number, number] | null {
  const view = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 24));
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    view.length < 24 ||
    signature.some((byte, index) => view[index] !== byte) ||
    view[12] !== 0x49 ||
    view[13] !== 0x48 ||
    view[14] !== 0x44 ||
    view[15] !== 0x52
  ) {
    return null;
  }
  return [readUint32BigEndian(view, 16), readUint32BigEndian(view, 20)];
}

function jpegDimensions(bytes: ArrayBuffer): readonly [number, number] | null {
  const view = new Uint8Array(bytes);
  if (view.length < 4 || view[0] !== 0xff || view[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 1 < view.length) {
    if (view[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (view[offset] === 0xff) offset += 1;
    if (offset >= view.length) return null;
    const marker = view[offset];
    offset += 1;
    if (marker === 0x00) continue;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 1 >= view.length) return null;
    const segmentLength = readUint16BigEndian(view, offset);
    if (segmentLength < 2 || offset + segmentLength > view.length) {
      return null;
    }
    if (isJpegFrameMarker(marker)) {
      if (segmentLength < 7 || offset + 7 > view.length) return null;
      return [
        readUint16BigEndian(view, offset + 5),
        readUint16BigEndian(view, offset + 3),
      ];
    }
    offset += segmentLength;
  }
  return null;
}

function isJpegFrameMarker(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function readUint16BigEndian(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) + bytes[offset + 1];
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 2 ** 24 +
    bytes[offset + 1] * 2 ** 16 +
    bytes[offset + 2] * 2 ** 8 +
    bytes[offset + 3]
  );
}

function clipboardImageMediaType(
  value: unknown,
): ClipboardImageMediaType | null {
  if (typeof value !== "string") return null;
  const mediaType = value.trim().toLowerCase();
  return isClipboardImageMediaType(mediaType) ? mediaType : null;
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
