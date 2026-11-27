import type { ReactNode } from "react";

import {
  ArtifactAttachmentScopeContext,
  type ArtifactAttachmentReadClient,
  type ArtifactAttachmentScopeValue,
} from "@/lib/attachments/artifact-attachment-scope-context";

/** `[1, 2, 3]`, so a decode failure cannot masquerade as an empty success. */
export const BYTES_BASE64 = "AQID";

export const FOUND_ANSWER = {
  ok: true as const,
  bytesBase64: BYTES_BASE64,
  mediaType: "image/png" as const,
};

export const DOWNLOADING_ANSWER = {
  ok: false as const,
  reason: "downloading" as const,
  receivedBytes: 1,
  totalBytes: 3,
};

export function scopeWith(
  requestWithSignal: ArtifactAttachmentReadClient["requestWithSignal"],
): ArtifactAttachmentScopeValue {
  return {
    epicId: "epic-1",
    artifactId: "artifact-1",
    hostId: "host-1",
    hostVersion: "1.2.3",
    client: { requestWithSignal },
  };
}

export function wrapperFor(
  scope: ArtifactAttachmentScopeValue | null,
): ({ children }: { children: ReactNode }) => ReactNode {
  return function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return (
      <ArtifactAttachmentScopeContext.Provider value={scope}>
        {children}
      </ArtifactAttachmentScopeContext.Provider>
    );
  };
}
