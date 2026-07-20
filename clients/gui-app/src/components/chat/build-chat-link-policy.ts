import type { QueryClient } from "@tanstack/react-query";
import type { UseNavigateResult } from "@tanstack/react-router";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ResolveArtifactByPathResult } from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { EPIC_ARTIFACT_INDEX_FILENAME } from "@traycer/protocol/common/artifact-path";
import {
  candidateWorkspaceFileRefsForAbsoluteLinkPath,
  candidateWorkspaceFileRefsForRelativeLinkPath,
  workspaceFileRefFromAbsoluteFilePath,
  workspaceFileRefFromLinkPath,
} from "@/components/epic-canvas/workspace-file/workspace-file-link-ref";
import { isAbsolutePath, joinPath } from "@/lib/path/cross-platform-path";
import { openProjectedSidebarNodeInTabWhenAvailable } from "@/components/epic-canvas/sidebar/open-projected-sidebar-node";
import { fetchResolveArtifactByPath } from "@/lib/host/resolve-artifact-by-path";
import { fetchWorkspaceFileExists } from "@/lib/host/probe-workspace-file-exists";
import {
  navigateToTabIntent,
  openOrFocusEpicIntent,
} from "@/lib/tab-navigation";
import { artifactEpicIdFromLinkPath } from "@/markdown/links/artifact-link-path";
import type { MarkdownFileLink } from "@/markdown/links/markdown-link-context";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { setWorkspaceFileRevealTarget } from "@/stores/epics/canvas/workspace-file-reveal-store";
import type {
  EpicCanvasTileRef,
  WorkspaceFileRef,
} from "@/stores/epics/canvas/types";

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
  /**
   * Client for the ARTIFACT-resolve RPC, bound to `activeHostId` (the
   * app-wide default host - epics are listed from it and the resolved
   * artifact tab is stamped with it, matching sidebar artifact opens).
   */
  readonly client: HostClient<HostRpcRegistry>;
  /**
   * Client for a RELATIVE plain-file link's existence probes, bound to
   * `hostId` (the chat tab's OWN host) - NOT `client`. `hostId` only scopes
   * the query KEY; `client.request(...)` always sends over whatever
   * connection the client itself is bound to. A tab pinned to a different
   * host than the app's active one must probe ITS OWN filesystem through a
   * client actually connected to that host, or the probe silently checks the
   * wrong machine while the opened ref is stamped with the tab's `hostId`.
   * `null` while the tab-scoped client hasn't resolved yet - a relative-link
   * click fails fast (the existing failure toast) rather than falling back to
   * `client`.
   */
  readonly workspaceClient: HostClient<HostRpcRegistry> | null;
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
  /** Reports an async artifact resolve/fallback that produced no open. */
  readonly onAsyncFailure: () => void;
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

    // A relative path is ambiguous across the chat's bound roots (they may
    // be unrelated sibling worktrees on disk), so it needs an existence
    // probe per candidate root - claim the click and resolve asynchronously.
    // An absolute path keeps the existing synchronous longest-prefix-match
    // resolution (deterministic, no probing needed).
    if (!isAbsolutePath(link.path)) {
      void resolveAndOpenRelativeWorkspaceFile(deps, lifecycle, link, {
        clickToken,
      });
      return true;
    }

    void resolveAndOpenAbsoluteWorkspaceFile(deps, lifecycle, link, {
      clickToken,
    });
    return true;
  };
}

/** The artifact-shaped link target: its epic id and the host to resolve against. */
export interface ArtifactLinkTarget {
  readonly artifactEpicId: string;
  readonly resolveHostId: string;
  /** The click's supersession token, checked when the RPC settles. */
  readonly clickToken: number;
}

/**
 * Opens an artifact already resolved via `epic.resolveArtifactByPath`: a
 * replaceable PREVIEW tile (routed through the projection waiter so a
 * not-yet-projected artifact opens as soon as it lands) when it belongs to
 * the currently open epic, or a cross-epic navigate+focus otherwise.
 *
 * Exported/shared so BOTH an already-index.md-shaped link's fast-path
 * resolve (`resolveAndOpenArtifactLink`) and a plain-link resolution whose
 * WINNING candidate turned out to be artifact-shaped
 * (`openResolvedWorkspaceTarget`, B) open an artifact the exact same way -
 * only what happens when the projection itself never lands differs per
 * caller, so that's the one thing left to the caller via `onUnavailable`.
 */
export interface ResolvedArtifactOpen {
  readonly artifact: ResolveArtifactByPathResult;
  readonly target: ArtifactLinkTarget;
  /** Called when the same-epic projection never lands (deleted mid-wait). */
  readonly onUnavailable: () => void;
}

export function openResolvedArtifact(
  deps: ChatLinkPolicyDeps,
  lifecycle: ChatLinkLifecycle,
  resolved: ResolvedArtifactOpen,
): void {
  const { artifact, target, onUnavailable } = resolved;
  const { artifactEpicId, resolveHostId } = target;
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
        // Projection never lands (deleted in a stale cache window): let the
        // caller degrade rather than a dead click.
        onUnavailable: () => {
          lifecycle.setPendingProjectedOpenCancel(null);
          onUnavailable();
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
  const fallbackToFilePreview = (): void => {
    if (lifecycle.isDisposed()) return;
    if (!lifecycle.isCurrent(clickToken)) return;
    if (!openChatWorkspaceFilePreview(deps, lifecycle, link, false)) {
      lifecycle.onAsyncFailure();
    }
  };
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
        fallbackToFilePreview();
        return;
      }
      openResolvedArtifact(deps, lifecycle, {
        artifact,
        target,
        onUnavailable: fallbackToFilePreview,
      });
    })
    .catch(() => {
      // Mirror the success path's guards: a tab torn down mid-flight, or a
      // newer click that already superseded this one, must NOT let a slow
      // rejected resolve open a fallback preview over the user's latest
      // selection (latest-click-wins). `openChatWorkspaceFilePreview` already
      // no-ops once disposed, but the supersession check only exists here.
      // Transport error on an artifact-shaped link: keep the safe no-op (D5) —
      // out-of-root synthesis stays disabled, so a missing artifact does not
      // open a raw / error tile.
      fallbackToFilePreview();
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
  openWorkspaceFileRef(deps, link, ref);
  return true;
}

/**
 * A `:line` target is transient and NOT part of tab identity: record it on
 * the (tab, content-id)-keyed reveal channel IMMEDIATELY BEFORE the open so
 * the tile (new or re-focused, deduped on `ref.id`) reads the fresh value on
 * mount / nonce change, then re-clicking a different line reuses the same tab
 * and re-scrolls. Artifact links carry no line, so only the plain-file paths
 * that call this touch the channel.
 */
function openWorkspaceFileRef(
  deps: ChatLinkPolicyDeps,
  link: MarkdownFileLink,
  ref: WorkspaceFileRef,
): void {
  if (link.line !== null) {
    setWorkspaceFileRevealTarget(deps.tabId, ref.id, link.line, link.col);
  }
  deps.previewTileInTab(deps.tabId, ref);
}

/** The click's supersession token, checked when the existence probe settles. */
interface WorkspaceFileProbeTarget {
  readonly clickToken: number;
}

/**
 * The winning candidate from either an absolute or relative existence-probe
 * race might structurally BE an artifact `index.md` even though it was
 * reached through the plain-workspace-file resolution path rather than the
 * fast-path `artifactEpicIdFromLinkPath(link.path)` check at the top of the
 * handler (which only catches a link ALREADY written index.md-shaped) - e.g.
 * a relative href resolves, against a bound root, onto
 * `.../epics/<id>/artifacts/<chain>/index.md`. Reclassifying the winner here
 * routes it through the artifact resolver (a collab tile) instead of a raw
 * file preview, keeping it capability-equivalent with a link already
 * authored index.md-shaped (B).
 */
export interface ResolvedWorkspaceFileTarget {
  readonly ref: WorkspaceFileRef;
  /** The click's supersession token, checked when the resolve settles. */
  readonly clickToken: number;
}

export function openResolvedWorkspaceTarget(
  deps: ChatLinkPolicyDeps,
  lifecycle: ChatLinkLifecycle,
  link: MarkdownFileLink,
  resolved: ResolvedWorkspaceFileTarget,
): void {
  const { ref, clickToken } = resolved;
  const fullPath = joinPath(ref.workspacePath, ref.filePath);
  const artifactEpicId = artifactEpicIdFromLinkPath(fullPath);
  if (artifactEpicId === null || deps.activeHostId === null) {
    openWorkspaceFileRef(deps, link, ref);
    return;
  }
  const resolveHostId = deps.activeHostId;
  const openAsPlainFile = (): void => {
    if (lifecycle.isDisposed()) return;
    if (!lifecycle.isCurrent(clickToken)) return;
    openWorkspaceFileRef(deps, link, ref);
  };
  void fetchResolveArtifactByPath({
    queryClient: deps.queryClient,
    client: deps.client,
    hostId: resolveHostId,
    epicId: artifactEpicId,
    filePath: fullPath,
  })
    .then((artifact) => {
      if (lifecycle.isDisposed()) return;
      if (!lifecycle.isCurrent(clickToken)) return;
      if (artifact === null) {
        openAsPlainFile();
        return;
      }
      openResolvedArtifact(deps, lifecycle, {
        artifact,
        target: { artifactEpicId, resolveHostId, clickToken },
        onUnavailable: openAsPlainFile,
      });
    })
    .catch(() => openAsPlainFile());
}

/**
 * Resolves as soon as the priority order can be DECIDED without waiting for
 * every probe: the winning index is the first `true` that has no still-
 * pending candidate before it (an earlier candidate's eventual `true` would
 * always outrank a later one, so a later `true` can't be trusted until every
 * earlier index is known). Resolves `-1` once every candidate has settled
 * `false`. A lower-priority probe still pending after the winner is decided
 * is left to settle on its own; its result is simply never read.
 *
 * A REJECTED probe is treated as `false`, the same as a settled miss - most
 * callers here already swallow their own transport errors
 * (`fetchWorkspaceFileExists` never rejects), but a caller that races a raw
 * RPC promise (e.g. an artifact-resolve candidate) must not be able to hang
 * this race forever: an unobserved rejection would leave that slot
 * permanently pending, blocking every later-priority candidate from ever
 * being decided and leaving the whole race unsettled.
 */
export function firstEagerlyTrueIndex(
  probes: ReadonlyArray<Promise<boolean>>,
): Promise<number> {
  if (probes.length === 0) return Promise.resolve(-1);
  return new Promise((resolve) => {
    const results: Array<boolean | undefined> = probes.map(() => undefined);
    let decided = false;
    const tryDecide = (): void => {
      if (decided) return;
      const firstPendingIndex = results.findIndex((r) => r === undefined);
      const firstTrueIndex = results.findIndex((r) => r === true);
      const decidedTrue =
        firstTrueIndex !== -1 &&
        (firstPendingIndex === -1 || firstTrueIndex < firstPendingIndex);
      if (decidedTrue) {
        decided = true;
        resolve(firstTrueIndex);
        return;
      }
      if (firstPendingIndex === -1) {
        decided = true;
        resolve(-1);
      }
    };
    probes.forEach((probe, index) => {
      void probe
        .then((value) => {
          results[index] = value;
          tryDecide();
        })
        .catch(() => {
          results[index] = false;
          tryDecide();
        });
    });
  });
}

/**
 * Resolves a RELATIVE plain-file link against every one of the chat's bound
 * roots and opens the first one that actually exists. Roots may be unrelated
 * sibling worktrees on disk, so - unlike an absolute path's deterministic
 * longest-prefix match - the right root can't be picked by string matching
 * alone; each candidate is probed via `workspace.readFile` (existence-only,
 * `maxBytes: 1`) THROUGH `deps.workspaceClient` (the chat's OWN bound host,
 * not the app-wide `deps.client`) at click time, run concurrently, and the
 * first-BY-PRIORITY-ORDER hit wins as soon as it's decided (`firstEagerlyTrueIndex`)
 * - a fast root-0 hit opens immediately rather than waiting on a slow
 * lower-priority root that can no longer change the outcome.
 *
 * Mirrors `resolveAndOpenArtifactLink`'s lifecycle guards: a torn-down tab or
 * a superseding later click drops this resolve silently; finding no existing
 * candidate reports `onAsyncFailure` (the click-failure toast). A `null`
 * `hostId` or not-yet-resolved `workspaceClient` fails the same way - there is
 * no host to probe against.
 */
function resolveAndOpenRelativeWorkspaceFile(
  deps: ChatLinkPolicyDeps,
  lifecycle: ChatLinkLifecycle,
  link: MarkdownFileLink,
  target: WorkspaceFileProbeTarget,
): Promise<void> {
  if (deps.hostId === null || deps.workspaceClient === null) {
    lifecycle.onAsyncFailure();
    return Promise.resolve();
  }
  const hostId = deps.hostId;
  const workspaceClient = deps.workspaceClient;
  const candidates = candidateWorkspaceFileRefsForRelativeLinkPath(
    hostId,
    deps.workspaceRoots,
    link.path,
  );
  if (candidates === null) {
    lifecycle.onAsyncFailure();
    return Promise.resolve();
  }
  const probes = candidates.map((ref) =>
    fetchWorkspaceFileExists({
      queryClient: deps.queryClient,
      client: workspaceClient,
      hostId,
      workspacePath: ref.workspacePath,
      filePath: ref.filePath,
    }),
  );
  return firstEagerlyTrueIndex(probes).then((winningIndex) => {
    if (lifecycle.isDisposed()) return;
    if (!lifecycle.isCurrent(target.clickToken)) return;
    if (winningIndex === -1) {
      lifecycle.onAsyncFailure();
      return;
    }
    openResolvedWorkspaceTarget(deps, lifecycle, link, {
      ref: candidates[winningIndex],
      clickToken: target.clickToken,
    });
  });
}

/**
 * The last resort for an ABSOLUTE link whose local existence probes all
 * missed: tries `directoryIndexPath` (the href suffixed with `index.md`)
 * through the root-prefix-agnostic artifact resolver ONCE, and only calls
 * `openDirectFallback` if that candidate isn't structurally artifact-shaped,
 * `activeHostId` isn't set, the resolve comes back `null`, or it rejects.
 *
 * Exists because a foreign-prefix artifact directory (a collaborator's
 * home, a different device's `~/.traycer`) can never win the local
 * existence-probe race - `workspace.readFile` only sees THIS machine's
 * filesystem - even though the RPC would resolve it correctly, since it
 * matches the `epics/<id>/artifacts/<chain>/index.md` marker as a
 * SUBSEQUENCE anywhere in the path rather than requiring a local prefix
 * match.
 */
function resolveArtifactShapedFallback(
  deps: ChatLinkPolicyDeps,
  lifecycle: ChatLinkLifecycle,
  fallback: {
    readonly clickToken: number;
    readonly directoryIndexPath: string;
    readonly openDirectFallback: () => void;
  },
): void {
  const { clickToken, directoryIndexPath, openDirectFallback } = fallback;
  const artifactEpicId = artifactEpicIdFromLinkPath(directoryIndexPath);
  const resolveHostId = deps.activeHostId;
  if (artifactEpicId === null || resolveHostId === null) {
    openDirectFallback();
    return;
  }
  void fetchResolveArtifactByPath({
    queryClient: deps.queryClient,
    client: deps.client,
    hostId: resolveHostId,
    epicId: artifactEpicId,
    filePath: directoryIndexPath,
  })
    .then((artifact) => {
      if (lifecycle.isDisposed()) return;
      if (!lifecycle.isCurrent(clickToken)) return;
      if (artifact === null) {
        openDirectFallback();
        return;
      }
      openResolvedArtifact(deps, lifecycle, {
        artifact,
        target: { artifactEpicId, resolveHostId, clickToken },
        onUnavailable: openDirectFallback,
      });
    })
    .catch(() => openDirectFallback());
}

/**
 * Resolves an ABSOLUTE plain-file link that isn't already a deterministic
 * bound-root match into whichever of its two shapes actually exists: the
 * direct file, or (a slashless target that's really a directory reference)
 * its `index.md` (A, C1). Mirrors the relative resolver's existence-probe
 * race (`firstEagerlyTrueIndex`) rather than the old purely string-based
 * longest-prefix match, so a real file like `spec/README.md` is never
 * coerced into `spec/README.md/index.md` just because the suffixed form
 * would ALSO parse as artifact-shaped.
 *
 * When NEITHER local candidate probes true, a structurally artifact-shaped
 * candidate (the href suffixed with `index.md`) still gets one shot through
 * the root-prefix-agnostic artifact resolver before falling back to the
 * direct candidate: a foreign-prefix artifact directory (a collaborator's
 * home, a different device) will never probe true against THIS machine's
 * filesystem, but the resolver doesn't care about the literal prefix
 * (`resolveArtifactShapedFallback`, C1/#4). Only once that also misses does
 * this open the direct candidate anyway rather than failing the click -
 * unlike the relative case, an absolute link has no "wrong workspace"
 * ambiguity to fail safely out of, so this preserves the deliberate "open
 * any agent-emitted file" capability `openChatWorkspaceFilePreview` already
 * had for the synchronous case.
 */
function resolveAndOpenAbsoluteWorkspaceFile(
  deps: ChatLinkPolicyDeps,
  lifecycle: ChatLinkLifecycle,
  link: MarkdownFileLink,
  target: WorkspaceFileProbeTarget,
): Promise<void> {
  const openDirectFallback = (): void => {
    if (lifecycle.isDisposed()) return;
    if (!lifecycle.isCurrent(target.clickToken)) return;
    if (!openChatWorkspaceFilePreview(deps, lifecycle, link, true)) {
      lifecycle.onAsyncFailure();
    }
  };
  // Computed from `link.path` alone (no host/workspace dependency), so it's
  // available even in the no-workspace-client branch below, where the
  // artifact resolver - bound to `deps.client`/`deps.activeHostId`, NOT
  // `deps.hostId`/`deps.workspaceClient` - can still be worth a try.
  const directoryIndexPath = joinPath(link.path, EPIC_ARTIFACT_INDEX_FILENAME);
  if (deps.hostId === null || deps.workspaceClient === null) {
    resolveArtifactShapedFallback(deps, lifecycle, {
      clickToken: target.clickToken,
      directoryIndexPath,
      openDirectFallback,
    });
    return Promise.resolve();
  }
  const hostId = deps.hostId;
  const workspaceClient = deps.workspaceClient;
  const candidates = candidateWorkspaceFileRefsForAbsoluteLinkPath(
    hostId,
    deps.workspaceRoots,
    link.path,
  );
  if (candidates === null) {
    openDirectFallback();
    return Promise.resolve();
  }
  const probes = candidates.map((ref) =>
    fetchWorkspaceFileExists({
      queryClient: deps.queryClient,
      client: workspaceClient,
      hostId,
      workspacePath: ref.workspacePath,
      filePath: ref.filePath,
    }),
  );
  return firstEagerlyTrueIndex(probes).then((winningIndex) => {
    if (lifecycle.isDisposed()) return;
    if (!lifecycle.isCurrent(target.clickToken)) return;
    if (winningIndex !== -1) {
      openResolvedWorkspaceTarget(deps, lifecycle, link, {
        ref: candidates[winningIndex],
        clickToken: target.clickToken,
      });
      return;
    }
    resolveArtifactShapedFallback(deps, lifecycle, {
      clickToken: target.clickToken,
      directoryIndexPath,
      openDirectFallback,
    });
  });
}
