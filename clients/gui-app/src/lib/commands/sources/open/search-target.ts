/** Shared identity for the opener's text-search sub-flow. */

export type SearchRunTarget =
  | { readonly kind: "artifact" }
  | { readonly kind: "code"; readonly hostId: string; readonly root: string };

const RUN_PREFIX = "open:search:run";
const ARTIFACT_ID = `${RUN_PREFIX}:artifact`;
const CODE_PREFIX = `${RUN_PREFIX}:code:`;

/**
 * The step-2 sub-page id for a target.
 * `hostId`/`root` are `encodeURIComponent`d (which escapes `:`, so a Windows `C:\…` root cannot collide with the field separator) and reconstructed by {@link parseSearchRunSubpageId}.
 */
export function searchRunSubpageId(target: SearchRunTarget): string {
  if (target.kind === "artifact") return ARTIFACT_ID;
  return `${CODE_PREFIX}${encodeURIComponent(target.hostId)}:${encodeURIComponent(target.root)}`;
}

export function isSearchRunSubpageId(id: string): boolean {
  return id === ARTIFACT_ID || id.startsWith(CODE_PREFIX);
}

export function parseSearchRunSubpageId(id: string): SearchRunTarget | null {
  if (id === ARTIFACT_ID) return { kind: "artifact" };
  if (!id.startsWith(CODE_PREFIX)) return null;
  const rest = id.slice(CODE_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep === -1) return null;
  try {
    return {
      kind: "code",
      hostId: decodeURIComponent(rest.slice(0, sep)),
      root: decodeURIComponent(rest.slice(sep + 1)),
    };
  } catch {
    return null;
  }
}
