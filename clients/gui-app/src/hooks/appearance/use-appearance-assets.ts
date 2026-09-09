import { useEffect, useMemo, useRef, useState } from "react";
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
  captureAppearanceSession,
  type AppearanceScope,
} from "@/lib/appearance/appearance-cache";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The real model this hook renders is `(scope, path) -> bytes | rejected |
 * loading`, split across five pieces of state because each answers a
 * different question the render needs:
 *  - `rejectedUrl` - a live-stream URL whose FETCH (network) failed; compared
 *    against the current `liveUrl` so a later successful fetch of a
 *    different URL isn't shadowed by an old rejection.
 *  - `failedResolution` - the (identity, url) pair `reportDecodeFailure`
 *    condemned; compared against the currently DISPLAYED (identity, url) so
 *    the condemnation applies only while that exact lease is still showing.
 *  - `retained` - the in-memory bytes of a live candidate that passed
 *    `validateAppearanceAssetBlob`, kept so `cachedFetcher` doesn't have to
 *    wait on `writeAppearanceBlob`'s IndexedDB round-trip to serve them back.
 *  - `displayed` (ref, not state - it must never itself trigger a render) -
 *    the (identity, url) actually committed to the DOM as of the last
 *    effect flush. `reportDecodeFailure` reads it to ignore a report that
 *    arrives from a PREVIOUSLY committed render (e.g. an `<img>` whose error
 *    handler fires after the hook already moved on to a newer lease) - a
 *    plain state variable can't express "as of the last commit" the way a
 *    ref written from a `useEffect` can.
 *  - `cachedFetcher` (memo, not state) - the fetch function
 *    `useImageBlobUrlState` drives; only its cache key changes, not its
 *    identity as a function.
 * All five were audited for redundancy (see FIX 6 of the appearance
 * code-review pass); none collapses into another without losing (a) "never
 * expose a live URL directly, only a validated blob" or (b) the stale-report
 * guard above, so this is the documented-in-place shape rather than a
 * reducer rewrite.
 */
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

/** The repository logo is the only appearance asset the host serves. */
export function useAppearanceAsset(args: {
  readonly scope: AppearanceScope | null;
  readonly path: string | null;
  readonly rejected: boolean;
  readonly focused: boolean;
  readonly refreshKey: number;
}): AppearanceAssetState {
  const { path, focused, rejected } = args;
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
  // `accessiblePath` is a single already-regex-constrained path (or `null`
  // when nothing is selected/accessible) - pass it straight through as the
  // identity; `appearanceAssetKey` is the only place that composes it into a
  // key, so it is stringified exactly once.
  const identity = appearanceAssetKey(scope, accessiblePath ?? "none");
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
          await validateAppearanceAssetBlob(blob);
        }
        signal.throwIfAborted();
        if (!session.isCurrent(scope?.accountId ?? null))
          throw new Error("Appearance session changed.");
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
      await validateAppearanceAssetBlob(blob);
      if (controller.signal.aborted || !session.isCurrent(scope.accountId))
        return;
      // Never expose the generic stream URL: only this admitted blob gets a display lease.
      setRetained({ identity, sourceUrl: liveUrl, blob });
      // Persistence is a cache optimization on top of an already-admitted
      // blob: `cachedFetcher` above serves `retained.blob` straight from
      // memory, so a failure to write it to IndexedDB must not fall into the
      // outer catch and mark this same URL rejected - that would report
      // `status: "unavailable"` for a blob the hook is still displaying.
      await writeAppearanceBlob(scope, accessiblePath, blob).catch(() => {});
    };
    void accept().catch(() => {
      if (!controller.signal.aborted) setRejectedUrl(liveUrl);
    });
    return () => controller.abort();
  }, [liveUrl, accessiblePath, scope, identity, rejected]);
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
