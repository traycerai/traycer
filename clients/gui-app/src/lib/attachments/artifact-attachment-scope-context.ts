import { createContext, use } from "react";

import type {
  FetchArtifactAttachmentRequest,
  FetchArtifactAttachmentResponse,
} from "@traycer/protocol/host/epic/artifact-attachment";

/**
 * Exactly the slice of the host client an artifact attachment read needs: this
 * ONE signal-bound method. Narrower than `HostClient` on purpose - the provider
 * hands its real client straight in (a generic `requestWithSignal` instantiates
 * to this), and a test can supply the one method instead of faking a whole
 * client class through an `as unknown` cast.
 */
export interface ArtifactAttachmentReadClient {
  requestWithSignal(
    method: "epic.fetchArtifactAttachment",
    params: FetchArtifactAttachmentRequest,
    signal: AbortSignal | undefined,
  ): Promise<FetchArtifactAttachmentResponse>;
}

/**
 * Everything an ARTIFACT image byte read is scoped by, resolved once per
 * artifact tile.
 *
 * The sibling of `ChatAttachmentScopeContext`, and it exists for a structural
 * reason rather than symmetry. Artifact image bytes are canonically stored in
 * the epic ROOT document, and on the lane arm that document is never seeded:
 * only the `@1` adapter emits on the root plane, so a lane-backed session's
 * `attachments` map stays empty for the life of the session and the waiting
 * doc read parks forever. `epic.fetchArtifactAttachment` is the answer the
 * protocol already ships for exactly this - "read attachment bytes that are
 * still canonically stored in the epic root document without putting that
 * document on the @2 stream" - and this scope is what lets a render site call
 * it.
 *
 * ## Why the ARTIFACT id is in here
 *
 * Because it is the authorization subject, not a convenience. A SHA-256 hash is
 * only a content address; the method takes `(epicId, artifactId, hash)` so the
 * host can prove access to the referenced artifact before serving bytes, which
 * is what stops a cache key from becoming a capability. The render site that
 * needs it is a Tiptap NodeView several layers below the tile, and the shared
 * extension bundle is a module-level singleton feeding one schema and one
 * markdown manager - so configuring the node per artifact is not available and
 * context is what remains.
 *
 * ## Why the CLIENT is in here too
 *
 * The same reason the chat scope carries one: resolving it per image would put
 * a query observer behind every thumbnail. The tile is `<TabHostProvider>`-bound
 * for life, so it resolves once and hands the result down. `null` is the
 * ordinary "not ready / signed out" value `useTabHostClient` already returns.
 *
 * `null` outside an artifact body - every surface with no artifact in scope
 * keeps the epic-doc byte source it already used.
 */
export interface ArtifactAttachmentScopeValue {
  readonly epicId: string;
  readonly artifactId: string;
  /** The tile's bound host - the one asked for the bytes. */
  readonly hostId: string;
  /**
   * That host's BUILD, from its directory entry; `null` while the directory has
   * not resolved one.
   *
   * Carried alongside the id because a host upgrade keeps its id: Traycer can
   * install and activate a newer build under the same `hostId` with no renderer
   * reload, and the fetcher remembers the "this host predates
   * `epic.fetchArtifactAttachment`" verdict per BUILD so that upgrade re-probes
   * instead of staying degraded for the session.
   */
  readonly hostVersion: string | null;
  /** Routed to `hostId`; `null` until the directory resolves it. */
  readonly client: ArtifactAttachmentReadClient | null;
}

export const ArtifactAttachmentScopeContext =
  createContext<ArtifactAttachmentScopeValue | null>(null);

export function useArtifactAttachmentScope(): ArtifactAttachmentScopeValue | null {
  return use(ArtifactAttachmentScopeContext);
}
