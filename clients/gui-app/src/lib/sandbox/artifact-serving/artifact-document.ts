import type { ForwardedShortcut } from "../forwarded-shortcuts";
import { buildDocument } from "../sandbox-document";
import type { SandboxTheme } from "../theme-map";

// Mirrors sandbox/index.html and the desktop sandbox handler's response header.
// Served documents need their own base policy when a catcher cannot set headers.
export const ARTIFACT_BASE_POLICY =
  "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'none'; base-uri 'none'";

export interface ArtifactDocumentOptions {
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
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_BASE_POLICY}">`,
  );
}
