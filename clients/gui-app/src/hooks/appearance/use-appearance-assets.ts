import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type {
  AppearanceUpload,
  WorkspaceAppearance,
} from "@traycer/protocol/host/workspace/appearance-schemas";
import { useHostFileAsset } from "@/hooks/assets/use-file-asset";
import { imageBlobCache } from "@/lib/attachments/image-blob-cache";
import {
  useImageBlobUrlState,
  type ImageBlobUrlState,
} from "@/lib/attachments/use-image-blob-url";
import {
  appearanceAssetKey,
  readAppearanceBlob,
  writeAppearanceBlob,
  pinGlobalAppearanceBlob,
  captureAppearanceSession,
  isAppearanceSessionCurrent,
  type AppearanceScope,
} from "@/lib/appearance/appearance-cache";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useSettingsStore,
  type GlobalWallpaper,
} from "@/stores/settings/settings-store";
import { workspaceMutationKeys } from "@/lib/query-keys";

export interface AppearanceAssetState {
  readonly url: string | null;
  readonly status: "empty" | "loading" | "ready" | "unavailable";
  readonly reason: string | null;
  readonly reportDecodeFailure: () => void;
}

function useStableAppearanceScope(
  input: AppearanceScope | null,
): AppearanceScope | null {
  const scopeAccount = input?.accountId ?? null;
  const scopeHost = input?.hostId ?? null;
  const scopeSource = input?.canonicalSourceRoot ?? null;
  return useMemo(
    () =>
      scopeAccount === null || scopeHost === null || scopeSource === null
        ? null
        : {
            accountId: scopeAccount,
            hostId: scopeHost,
            canonicalSourceRoot: scopeSource,
          },
    [scopeAccount, scopeHost, scopeSource],
  );
}

function appearanceAssetStatus(args: {
  path: string | null;
  failed: boolean;
  unavailable: boolean;
  cached: ImageBlobUrlState;
}): AppearanceAssetState["status"] {
  if (args.path === null) return "empty";
  if (args.failed) return "unavailable";
  if (args.cached.status === "ready") return "ready";
  if (args.unavailable && args.cached.status === "unavailable")
    return "unavailable";
  return "loading";
}

function appearanceImagePath(
  image: WorkspaceAppearance["icon"] | WorkspaceAppearance["wallpaper"] | null,
): string | null {
  return image?.kind === "image" ? image.path : null;
}

function appearanceAssetRequest(
  scope: AppearanceScope | null,
  path: string | null,
  rejected: boolean,
) {
  if (scope === null || path === null || rejected) return null;
  return {
    method: "workspace" as const,
    workspacePath: scope.canonicalSourceRoot,
    filePath: `.traycer/${path}`,
  };
}

function loadAppearanceAssetValidation() {
  return import("@/lib/appearance/appearance-asset-validation");
}

export function useAppearanceAsset(args: {
  readonly scope: AppearanceScope | null;
  readonly path: string | null;
  readonly target: AppearanceUpload["target"];
  readonly rejected: boolean;
  readonly focused: boolean;
  readonly refreshKey: number;
}): AppearanceAssetState {
  const { path, focused, target, rejected } = args;
  const scope = useStableAppearanceScope(args.scope);
  const accountId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  const accessiblePath =
    scope !== null && scope.accountId !== accountId ? null : path;
  const live = useHostFileAsset({
    hostId: scope?.hostId ?? null,
    request: appearanceAssetRequest(scope, accessiblePath, rejected),
    focused,
    refreshKey: args.refreshKey,
  });
  const identity = appearanceAssetKey(
    scope,
    JSON.stringify([accessiblePath, target]),
  );
  const [rejectedUrl, setRejectedUrl] = useState<string | null>(null);
  const [failedResolution, setFailedResolution] = useState<{
    identity: string;
    url: string | null;
  } | null>(null);
  const [retained, setRetained] = useState<{
    identity: string;
    sourceUrl: string;
    blob: Blob;
  } | null>(null);
  const latest = retained?.identity === identity ? retained : null;
  const cachedFetcher = useMemo(
    () => ({
      scopeKey: JSON.stringify([identity, latest?.sourceUrl ?? null]),
      fetch: async (_key: string, signal: AbortSignal) => {
        const session = captureAppearanceSession();
        if (accessiblePath === null)
          throw new Error("No appearance image selected.");
        const blob =
          latest?.blob ?? (await readAppearanceBlob(scope, accessiblePath));
        if (blob === null) throw new Error("Appearance image is not cached.");
        if (latest === null) {
          const { validateAppearanceAssetBlob } =
            await loadAppearanceAssetValidation();
          await validateAppearanceAssetBlob(blob, target);
        }
        signal.throwIfAborted();
        if (!isAppearanceSessionCurrent(scope?.accountId ?? null, session))
          throw new Error("Appearance session changed.");
        return {
          bytes: new Uint8Array(await blob.arrayBuffer()),
          mediaType: blob.type,
        };
      },
    }),
    [identity, scope, accessiblePath, latest, target],
  );
  const cached = useImageBlobUrlState(
    accessiblePath,
    "image/webp",
    cachedFetcher,
    null,
  );
  const liveUrl = live.status === "ready" ? live.url : null;
  useEffect(() => {
    if (
      liveUrl === null ||
      accessiblePath === null ||
      scope === null ||
      rejected
    )
      return;
    const controller = new AbortController();
    const session = captureAppearanceSession();
    const accept = async () => {
      const response = await fetch(liveUrl, { signal: controller.signal });
      if (!response.ok) throw new Error("Appearance image is unavailable.");
      const blob = await response.blob();
      controller.signal.throwIfAborted();
      const { validateAppearanceAssetBlob } =
        await loadAppearanceAssetValidation();
      controller.signal.throwIfAborted();
      await validateAppearanceAssetBlob(blob, target);
      if (
        controller.signal.aborted ||
        !isAppearanceSessionCurrent(scope.accountId, session)
      )
        return;
      // Never expose the generic stream URL: only this admitted blob gets a display lease.
      setRetained({ identity, sourceUrl: liveUrl, blob });
      await writeAppearanceBlob(scope, accessiblePath, blob);
    };
    void accept().catch(() => {
      if (!controller.signal.aborted) setRejectedUrl(liveUrl);
    });
    return () => controller.abort();
  }, [liveUrl, accessiblePath, scope, identity, target, rejected]);
  const url = cached.url;
  const failed =
    failedResolution?.identity === identity && failedResolution.url === url;
  const displayed = useRef<{ identity: string; url: string | null } | null>(
    null,
  );
  useEffect(() => {
    displayed.current = { identity, url };
    return () => {
      displayed.current = null;
    };
  }, [identity, url]);
  return {
    url: accessiblePath === null || failed ? null : url,
    status: appearanceAssetStatus({
      path: accessiblePath,
      failed,
      unavailable:
        rejected ||
        rejectedUrl === liveUrl ||
        live.status === "fallback" ||
        scope === null,
      cached,
    }),
    reason: live.reason,
    reportDecodeFailure: () => {
      if (
        accessiblePath === null ||
        displayed.current?.identity !== identity ||
        displayed.current.url !== url
      )
        return;
      if (latest?.sourceUrl === liveUrl) live.reportDecodeFailure();
      imageBlobCache.discard(cachedFetcher.scopeKey, accessiblePath);
      setFailedResolution({ identity, url });
      // Keep persistence untouched: this failed lease may predate a newer accepted write.
    },
  };
}

export function useResolvedAppearanceAssets(args: {
  readonly scope: AppearanceScope | null;
  readonly appearance: WorkspaceAppearance | null;
  readonly issues: readonly string[];
  readonly focused: boolean;
  readonly refreshKey: number;
}) {
  const globalWallpaper = useSettingsStore((state) => state.globalWallpaper);
  const wallpaper = args.appearance?.wallpaper ?? globalWallpaper;
  const projectPath =
    args.scope === null
      ? null
      : appearanceImagePath(args.appearance?.wallpaper);
  const project = useAppearanceAsset({
    scope: args.scope,
    path: projectPath,
    target: "wallpaper",
    rejected: args.issues.includes("wallpaper"),
    focused: args.focused,
    refreshKey: args.refreshKey,
  });
  const globalPath =
    wallpaper?.kind === "none" ? null : appearanceImagePath(globalWallpaper);
  const global = useAppearanceAsset({
    scope: null,
    path: globalPath,
    target: "wallpaper",
    rejected: false,
    focused: args.focused,
    refreshKey: args.refreshKey,
  });
  const icon = useAppearanceAsset({
    scope: args.scope,
    path:
      args.scope === null ? null : appearanceImagePath(args.appearance?.icon),
    target: "icon",
    rejected: args.issues.includes("icon"),
    focused: args.focused,
    refreshKey: args.refreshKey,
  });
  const usesProject = projectPath !== null && project.url !== null;
  const resolvedWallpaper = usesProject ? wallpaper : globalWallpaper;
  const wallpaperUrl = usesProject ? project.url : global.url;
  return {
    wallpaper: wallpaper?.kind === "none" ? wallpaper : resolvedWallpaper,
    wallpaperUrl: wallpaper?.kind === "none" ? null : wallpaperUrl,
    iconUrl: icon.url,
    project,
    icon,
  };
}

export function useSaveGlobalAppearance() {
  return useMutation({
    mutationKey: workspaceMutationKeys.saveGlobalAppearance(),
    mutationFn: async (input: {
      readonly wallpaper: GlobalWallpaper;
      readonly blob: Blob | null;
      readonly showGreeting: boolean;
      readonly showRecentHistory: boolean;
    }) => {
      const session = captureAppearanceSession();
      if (input.wallpaper?.kind === "image" && input.blob !== null)
        await writeAppearanceBlob(null, input.wallpaper.path, input.blob);
      await pinGlobalAppearanceBlob(
        input.wallpaper?.kind === "image" ? input.wallpaper.path : null,
      );
      if (!isAppearanceSessionCurrent(null, session))
        throw new Error("Appearance settings are being cleared.");
      useSettingsStore.setState({
        globalWallpaper: input.wallpaper,
        showGreeting: input.showGreeting,
        showRecentHistory: input.showRecentHistory,
      });
    },
  });
}
