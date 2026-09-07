import { createContext, use } from "react";

import type {
  FetchArtifactAttachmentRequest,
  FetchArtifactAttachmentResponse,
} from "@traycer/protocol/host/epic/artifact-attachment";

/**
 * Exactly the slice of the host client an artifact attachment read needs: this ONE signal-bound method.
 * Narrower than `HostClient` on purpose - the provider hands its real client straight in (a generic `requestWithSignal` instantiates to this), and a test can supply the one method instead of faking a whole client class through an `as unknown` cast.
 */
export interface ArtifactAttachmentReadClient {
  requestWithSignal(
    method: "epic.fetchArtifactAttachment",
    params: FetchArtifactAttachmentRequest,
    signal: AbortSignal | undefined,
  ): Promise<FetchArtifactAttachmentResponse>;
}

/**
 * Artifact image byte scope, resolved once per tile.
 * Artifact id is the authorization subject (a hash is not a capability).
 */
export interface ArtifactAttachmentScopeValue {
  readonly epicId: string;
  readonly artifactId: string;
  /** The tile's bound host - the one asked for the bytes. */
  readonly hostId: string;
  /** That host's BUILD, from its directory entry; `null` while the directory has not resolved one. */
  readonly hostVersion: string | null;
  /** Routed to `hostId`; `null` until the directory resolves it. */
  readonly client: ArtifactAttachmentReadClient | null;
}

export const ArtifactAttachmentScopeContext =
  createContext<ArtifactAttachmentScopeValue | null>(null);

export function useArtifactAttachmentScope(): ArtifactAttachmentScopeValue | null {
  return use(ArtifactAttachmentScopeContext);
}
