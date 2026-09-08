import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { WorkspaceAppearance } from "@traycer/protocol/host/workspace/appearance-schemas";
import {
  useHostFileAsset,
  type UseFileAssetResult,
} from "@/hooks/assets/use-file-asset";
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
  removeAppearanceBlob,
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
  liveUrl: string | null;
  live: UseFileAssetResult;
  cached: ImageBlobUrlState;
  scope: AppearanceScope | null;
}): AppearanceAssetState["status"] {
  if (args.path === null) return "empty";
  if (args.failed) return "unavailable";
  if (args.liveUrl !== null || args.cached.status === "ready") return "ready";
  if (
    args.live.status === "fallback" ||
    (args.scope === null && args.cached.status === "unavailable")
  )
    return "unavailable";
  return "loading";
}

function failedAssetResolution(
  failed: { identity: string; url: string | null } | null,
  identity: string,
  liveUrl: string | null,
): boolean {
  return (
    failed?.identity === identity &&
    (liveUrl === null || failed.url === liveUrl)
  );
}

function appearanceImagePath(
  image: WorkspaceAppearance["icon"] | WorkspaceAppearance["wallpaper"] | null,
): string | null {
  return image?.kind === "image" ? image.path : null;
}

export function useAppearanceAsset(args: {
  readonly scope: AppearanceScope | null;
  readonly path: string | null;
  readonly focused: boolean;
  readonly refreshKey: number;
}): AppearanceAssetState {
  const { path, focused } = args;
  const scope = useStableAppearanceScope(args.scope);
  const accountId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  const accessiblePath =
    scope !== null && scope.accountId !== accountId ? null : path;
  const live = useHostFileAsset({
    hostId: scope?.hostId ?? null,
    request:
      scope === null || accessiblePath === null
        ? null
        : {
            method: "workspace",
            workspacePath: scope.canonicalSourceRoot,
            filePath: `.traycer/${accessiblePath}`,
          },
    focused,
    refreshKey: args.refreshKey,
  });
  const identity = appearanceAssetKey(scope, accessiblePath ?? "");
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
      fetch: async () => {
        if (accessiblePath === null)
          throw new Error("No appearance image selected.");
        const blob =
          latest?.blob ?? (await readAppearanceBlob(scope, accessiblePath));
        if (blob === null) throw new Error("Appearance image is not cached.");
        return {
          bytes: new Uint8Array(await blob.arrayBuffer()),
          mediaType: blob.type,
        };
      },
    }),
    [identity, scope, accessiblePath, latest],
  );
  const cached = useImageBlobUrlState(
    accessiblePath,
    "image/webp",
    cachedFetcher,
    null,
  );
  const liveUrl = live.status === "ready" ? live.url : null;
  const latestLive = useRef<{ identity: string; url: string } | null>(null);
  useEffect(
    () => () => {
      latestLive.current = null;
    },
    [identity],
  );
  useEffect(() => {
    if (liveUrl === null || accessiblePath === null || scope === null) return;
    latestLive.current = { identity, url: liveUrl };
    const session = captureAppearanceSession();
    void fetch(liveUrl)
      .then((response) => response.blob())
      .then(async (blob) => {
        if (
          latestLive.current?.identity !== identity ||
          latestLive.current.url !== liveUrl ||
          !isAppearanceSessionCurrent(scope.accountId, session)
        )
          return;
        // Give the newest bytes their own shared lease before the stream's URL
        // is released. A later offline refresh must not revive an older lease.
        setRetained({ identity, sourceUrl: liveUrl, blob });
        await writeAppearanceBlob(scope, accessiblePath, blob);
      })
      .catch(() => {});
  }, [liveUrl, accessiblePath, scope, identity]);
  const url = liveUrl ?? cached.url;
  const failed = failedAssetResolution(failedResolution, identity, liveUrl);
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
      liveUrl,
      live,
      cached,
      scope,
    }),
    reason: live.reason,
    reportDecodeFailure: () => {
      if (
        accessiblePath === null ||
        displayed.current?.identity !== identity ||
        displayed.current.url !== url
      )
        return;
      live.reportDecodeFailure();
      if (latestLive.current?.url === url) latestLive.current = null;
      imageBlobCache.discard(cachedFetcher.scopeKey, accessiblePath);
      setFailedResolution({ identity, url });
      void removeAppearanceBlob(scope, accessiblePath).catch(() => {});
    },
  };
}

export function useResolvedAppearanceAssets(args: {
  readonly scope: AppearanceScope | null;
  readonly appearance: WorkspaceAppearance | null;
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
    focused: args.focused,
    refreshKey: args.refreshKey,
  });
  const globalPath =
    wallpaper?.kind === "none" ? null : appearanceImagePath(globalWallpaper);
  const global = useAppearanceAsset({
    scope: null,
    path: globalPath,
    focused: args.focused,
    refreshKey: args.refreshKey,
  });
  const icon = useAppearanceAsset({
    scope: args.scope,
    path:
      args.scope === null ? null : appearanceImagePath(args.appearance?.icon),
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
