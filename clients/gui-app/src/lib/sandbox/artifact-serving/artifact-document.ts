import type { ForwardedShortcut } from "../forwarded-shortcuts";
import { buildDocument } from "../sandbox-document";
import type { SandboxTheme } from "../theme-map";

// Every intersecting policy must name the scheme: WebKit's wildcard does
// not admit custom-scheme subresources from an opaque sandbox document.
export function artifactBasePolicy(policySource: string | null): string {
  if (policySource !== null && !/^[A-Za-z][A-Za-z0-9+.-]*:$/.test(policySource)) {
    throw new Error("Invalid artifact policy source");
  }
  return `default-src *${policySource === null ? "" : ` ${policySource}`} data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'none'; base-uri 'none'`;
}

export interface ArtifactDocumentOptions {
  readonly policySource: string | null;
  readonly csp: string | null;
  readonly theme: SandboxTheme;
  readonly nonce: string;
  readonly shortcuts: readonly ForwardedShortcut[];
}

export function buildArtifactDocument(
  html: string,
  options: ArtifactDocumentOptions,
): string {
  const document = buildDocument({
    html,
    ...options,
    theme: {
      ...options.theme,
      variables: Object.entries(options.theme.variables),
    },
  });
  return document.replace(
    /^<!doctype html>/,
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${artifactBasePolicy(options.policySource)}">`,
  );
}
