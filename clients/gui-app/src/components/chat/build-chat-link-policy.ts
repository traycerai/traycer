import type { QueryClient } from "@tanstack/react-query";
import type { UseNavigateResult } from "@tanstack/react-router";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import {
  workspaceFileRefFromAbsoluteFilePath,
  workspaceFileRefFromLinkPath,
} from "@/components/epic-canvas/workspace-file/workspace-file-link-ref";
import { isAbsolutePath } from "@/lib/path/cross-platform-path";
import { openProjectedSidebarNodeInTabWhenAvailable } from "@/components/epic-canvas/sidebar/open-projected-sidebar-node";
import { fetchResolveArtifactByPath } from "@/lib/host/resolve-artifact-by-path";
import {
  navigateToTabIntent,
  openOrFocusEpicIntent,
} from "@/lib/tab-navigation";
import { artifactEpicIdFromLinkPath } from "@/markdown/links/artifact-link-path";
import type { MarkdownFileLink } from "@/markdown/links/markdown-link-context";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { setWorkspaceFileRevealTarget } from "@/stores/epics/canvas/workspace-file-reveal-store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

/**
 * Static dependencies the chat link policy closes over, all sourced from React
 * hooks (host ids, the open epic id, the canvas opener, the query client, …) and
 * passed straight through. They never change within a single click, so the
 * builder captures them once.
 */
export interface ChatLinkPolicyDeps {
  /** The chat tab whose group a file link opens its new tab into. */
  readonly tabId: string;
  /** Host the chat is bound to; file tabs are stamped with it for life. */
  readonly hostId: string | null;
  /** The chat's working directories, used to resolve a link path to a file. */
  readonly workspaceRoots: ReadonlyArray<string>;
  /** Active/default host the artifact RPC + tile open are stamped with. */
  readonly activeHostId: string | null;
  /** The currently-open epic id; same-epic links preview, others navigate. */
  readonly openEpicId: string;
  readonly epicHandle: OpenEpicStoreHandle;
  readonly queryClient: QueryClient;
  readonly client: HostClient<HostRpcRegistry>;
  readonly navigate: UseNavigateResult<string>;
  readonly previewTileInTab: (tabId: string, node: EpicCanvasTileRef) => void;
}

/**
 * The cancellation lifecycle, OWNED by the component (refs + an unmount effect)
 * and threaded in at click time — not at build time — so the builder stays a
 * pure function with no hooks and React's "no refs during render" rule is never
 * tripped (reading `.current` happens inside the click handler that supplies
 * this).
 *
 * - `isDisposed` reports whether the owning chat tab has unmounted, so the
 *   deferred opens (the resolve `.then` and the projection waiter's
 *   `onUnavailable`) drop rather than acting on a torn-down tab.
 * - `getPendingProjectedOpenCancel` / `setPendingProjectedOpenCancel` read and
 *   write the single in-flight projection-wait cancel handle, so a superseding
 *   click or an unmount can tear down the `store.subscribe` + 30s timeout.
 * - `beginClick` / `isCurrent` back a monotonic supersession token (a ref-held
 *   counter in the component): each click bumps the token, and a deferred
 *   resolve checks `isCurrent` so a slow earlier RPC that settles AFTER a newer
 *   click drops instead of opening/navigating over the latest click.
 */
export interface ChatLinkLifecycle {
  readonly isDisposed: () => boolean;
  readonly getPendingProjectedOpenCancel: () => (() => void) | null;
  readonly setPendingProjectedOpenCancel: (cancel: (() => void) | null) => void;
  /** Bumps the supersession token for a fresh click and returns it. */
  readonly beginClick: () => number;
  /** Whether `token` is still the latest click (not yet superseded). */
  readonly isCurrent: (token: number) => boolean;
}

/** Synchronous boolean handler markdown anchors call for a file-shaped link. */
export type ChatLinkHandler = (
  link: MarkdownFileLink,
  lifecycle: ChatLinkLifecycle,
) => boolean;

/**
 * Builds the file-link handler that markdown anchors in chat call when a link
 * points at a file. Two link shapes flow through the handler:
 *
 * - **Artifact links** (`…/epics/<epicId>/artifacts/<chain>/index.md`) resolve
 *   via the read-only `epic.resolveArtifactByPath` RPC (against the
 *   ACTIVE/default host, matching sidebar artifact opens) to a stable
 *   `{ artifactId, kind }`, then open the artifact tile: a replaceable PREVIEW
 *   when the link targets the currently-open epic, or a focus-navigate to the
 *   target epic when it points elsewhere. A `null` resolve (deleted / not yet
 *   minted / unresolved chain) or a transport rejection degrades through
 *   `openChatWorkspaceFilePreview` with out-of-root synthesis DISABLED, so an
 *   artifact `index.md` (which normally lives under `~/.traycer`, outside the
 *   chat's roots) stays a safe no-op rather than opening a raw / error tile
 *   (D5 / CL-1).
 * - **Plain file links** resolve against the chat's working directories and
 *   open as a replaceable workspace-file preview tab, stamped with the chat's
 *   own `hostId` for life. An ABSOLUTE path belonging to no bound root is still
 *   opened, by treating its own directory as the workspace root (the deliberate
 *   "open any agent-emitted file" capability). Directories are left unhandled
 *   because `openExternalLink` is web-only.
 *
 * The RPC is async but the handler is synchronous: for an artifact-shaped path
 * we kick off the resolve fire-and-forget and return `true` immediately (the
 * click is handled), opening/navigating once it settles. A `:line` target only
 * applies to normal files: the file branch records it on the (tab, content-id)-
 * keyed reveal channel right before opening, so the tile scrolls to and
 * highlights the line; artifact links ignore it.
 */
export function buildChatLinkPolicy(deps: ChatLinkPolicyDeps): ChatLinkHandler {
  return (link, lifecycle) => {
    if (link.isDirectory) return false;

    // Supersession (latest-click-wins): bump the token and SILENTLY cancel any
    // pending projection wait BEFORE branching, so ANY newer click — plain
    // file or cross-epic, not just a same-epic settle — abandons a prior wait
    // instead of letting it open the prior link over this one. The cancel is
    // silent (no `onUnavailable` fallback) per `open-projected-sidebar-node`.
    const clickToken = lifecycle.beginClick();
    lifecycle.getPendingProjectedOpenCancel()?.();
    lifecycle.setPendingProjectedOpenCancel(null);

    // Artifact-shaped link: resolve the on-disk path to its stable id and open
    // the artifact tile. Root-prefix-agnostic so cross-machine links
    // (collaborators, second device, foreign home prefix) still match.
    const artifactEpicId = artifactEpicIdFromLinkPath(link.path);
    if (artifactEpicId !== null && deps.activeHostId !== null) {
      // The RPC is async; the handler is sync. Kick off the resolve and claim
      // the click (`true`), opening once it settles.
      void resolveAndOpenArtifactLink(deps, lifecycle, link, {
        artifactEpicId,
        resolveHostId: deps.activeHostId,
        clickToken,
      });
      return true;
    }

    return openChatWorkspaceFilePreview(deps, lifecycle, link, true);
  };
}

/** The artifact-shaped link target: its epic id and the host to resolve against. */
interface ArtifactLinkTarget {
  readonly artifactEpicId: string;
  readonly resolveHostId: string;
  /** The click's supersession token, checked when the RPC settles. */
  readonly clickToken: number;
}

/**
 * Resolve an artifact-shaped link to its stable id and open it. On a `null`
 * resolve or a transport rejection, degrades to the raw file preview.
 */
function resolveAndOpenArtifactLink(
  deps: ChatLinkPolicyDeps,
  lifecycle: ChatLinkLifecycle,
  link: MarkdownFileLink,
  target: ArtifactLinkTarget,
): Promise<void> {
  const { artifactEpicId, resolveHostId, clickToken } = target;
  return fetchResolveArtifactByPath({
    queryClient: deps.queryClient,
    client: deps.client,
    hostId: resolveHostId,
    epicId: artifactEpicId,
    filePath: link.path,
  })
    .then((artifact) => {
      // The provider unmounted while the resolve was in flight: drop the
      // deferred open rather than acting on a torn-down tab.
      if (lifecycle.isDisposed()) return;
      // A newer click superseded this one mid-flight: drop this stale settle so
      // an out-of-order resolve can't open/navigate/install a wait over the
      // latest click (latest-click-wins).
      if (!lifecycle.isCurrent(clickToken)) return;
      if (artifact === null) {
        openChatWorkspaceFilePreview(deps, lifecycle, link, false);
        return;
      }
      if (artifactEpicId === deps.openEpicId) {
        // Same epic: open a replaceable PREVIEW tile stamped with the active
        // host. Route through the projection waiter (passing the PREVIEW
        // opener, D3) so an artifact not yet projected opens as soon as it
        // lands, and the tile name comes from the loaded projection. Any prior
        // wait was already silently cancelled at click time (supersession at
        // the top of the handler); retain the new handle so a later superseding
        // click or an unmount can tear down the subscribe + 30s timeout.
        lifecycle.setPendingProjectedOpenCancel(
          openProjectedSidebarNodeInTabWhenAvailable({
            epicHandle: deps.epicHandle,
            tabId: deps.tabId,
            nodeId: artifact.artifactId,
            fallbackHostId: resolveHostId,
            openTileInTab: deps.previewTileInTab,
            onBeforeOpen: null,
            onOpened: () => {
              lifecycle.setPendingProjectedOpenCancel(null);
            },
            // Projection never lands (deleted in a stale cache window): degrade
            // to the raw file preview rather than a dead click.
            // `openChatWorkspaceFilePreview` no-ops once disposed, so a
            // cancel-on-unmount won't open into a dead tab.
            onUnavailable: () => {
              lifecycle.setPendingProjectedOpenCancel(null);
              openChatWorkspaceFilePreview(deps, lifecycle, link, false);
            },
            onCleanup: null,
          }),
        );
        return;
      }
      // Cross epic: navigate + focus the artifact via the existing route-sync
      // auto-open. A FRESH `focusedAt` per click ensures re-clicking after
      // closing the tab re-opens it (the auto-open effect dedups on
      // `epicId|focusArtifactId|focusedAt`).
      navigateToTabIntent(
        deps.navigate,
        openOrFocusEpicIntent({
          epicId: artifactEpicId,
          focus: {
            focusArtifactId: artifact.artifactId,
            focusedAt: Date.now(),
            focusThreadId: undefined,
            migrationSource: undefined,
          },
        }),
      );
    })
    .catch(() => {
      // Mirror the success path's guards: a tab torn down mid-flight, or a
      // newer click that already superseded this one, must NOT let a slow
      // rejected resolve open a fallback preview over the user's latest
      // selection (latest-click-wins). `openChatWorkspaceFilePreview` already
      // no-ops once disposed, but the supersession check only exists here.
      if (lifecycle.isDisposed()) return;
      if (!lifecycle.isCurrent(clickToken)) return;
      // Transport error on an artifact-shaped link: keep the safe no-op (D5) —
      // out-of-root synthesis stays disabled, so a missing artifact does not
      // open a raw / error tile.
      openChatWorkspaceFilePreview(deps, lifecycle, link, false);
    });
}

/**
 * Plain links resolve against the chat's working directories and open as a
 * workspace-file preview stamped with the CHAT's host for life (NOT the active
 * host — file tabs keep `tabHostId`).
 *
 * When the in-root resolution misses and `synthesizeOutOfRoot` is set, an
 * ABSOLUTE path belonging to no bound root is opened by treating its own
 * directory as the workspace root (`workspaceFileRefFromAbsoluteFilePath`) — the
 * deliberate "open any agent-emitted file" capability. Only the plain-file
 * branch passes `true`; the artifact-resolve fallbacks pass `false`, so a
 * deleted / not-yet-minted artifact whose `index.md` is out-of-root stays a safe
 * no-op rather than opening an error tile (D5 / CL-1).
 *
 * Returns `false` (unhandled) for a torn-down tab, a missing host, a directory,
 * or a path that resolves to neither a bound root nor (when permitted) an
 * absolute file.
 */
function openChatWorkspaceFilePreview(
  deps: ChatLinkPolicyDeps,
  lifecycle: ChatLinkLifecycle,
  link: MarkdownFileLink,
  synthesizeOutOfRoot: boolean,
): boolean {
  // The chat tab was torn down (unmount cancels the projection wait, which
  // routes here via `onUnavailable`): never open into a dead tab.
  if (lifecycle.isDisposed()) return false;
  if (deps.hostId === null) return false;
  // In-root files keep their root-relative ref (correct header + identity).
  // Only the plain-file branch falls back to synthesizing a root from an
  // out-of-root absolute path's own directory.
  const ref =
    workspaceFileRefFromLinkPath(deps.hostId, deps.workspaceRoots, link.path) ??
    (synthesizeOutOfRoot && isAbsolutePath(link.path)
      ? workspaceFileRefFromAbsoluteFilePath(deps.hostId, link.path)
      : null);
  if (ref === null) return false;
  // A `:line` target is transient and NOT part of tab identity: record it on
  // the (tab, content-id)-keyed reveal channel IMMEDIATELY BEFORE the open so
  // the tile (new or re-focused, deduped on `ref.id`) reads the fresh value on
  // mount / nonce change, then re-clicking a different line reuses the same tab
  // and re-scrolls. Artifact links carry no line, so only this normal-file
  // branch touches the channel.
  if (link.line !== null) {
    setWorkspaceFileRevealTarget(deps.tabId, ref.id, link.line, link.col);
  }
  deps.previewTileInTab(deps.tabId, ref);
  return true;
}
