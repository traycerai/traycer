import {
  buildCanvasPrelude,
  buildHtmlSelectionPrelude,
} from "../canvas-bootstrap";
import { stampPositions } from "@traycer/html-source";
import type { ForwardedShortcut } from "../forwarded-shortcuts";
import { buildDocument, type ArtifactPageRole } from "../sandbox-document";
import type { SandboxTheme } from "../theme-map";
import { buildHtmlViewerPrelude } from "../html-viewer-bootstrap";

// Every intersecting policy must name the scheme: WebKit's wildcard does
// not admit custom-scheme subresources from an opaque sandbox document.
export function artifactBasePolicy(policySource: string | null): string {
  if (
    policySource !== null &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:$/.test(policySource)
  ) {
    throw new Error("Invalid artifact policy source");
  }
  return `default-src *${policySource === null ? "" : ` ${policySource}`} data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'none'; base-uri 'none'`;
}

export interface ArtifactDocumentOptions {
  readonly artifactRootPath?: string;
  readonly canvas?: boolean;
  readonly canvasLinks?: "native";
  readonly policySource: string | null;
  readonly csp: string | null;
  readonly theme: SandboxTheme;
  readonly nonce: string;
  readonly shortcuts: readonly ForwardedShortcut[];
}

/** Canvas boards report their links to the app; plain html pages follow them. */
function isPlainHtmlPage(options: ArtifactDocumentOptions): boolean {
  return options.canvas !== true || options.canvasLinks === "native";
}

export function buildArtifactDocument(
  html: string,
  options: ArtifactDocumentOptions,
): string {
  return composeArtifactDocument(
    html,
    options,
    isPlainHtmlPage(options) ? "found" : null,
  );
}

/**
 * Stands in for an `.html` page the artifact does not have, so a link to it
 * still loads a document that proves itself and tells the app the page is
 * missing, instead of a blank browser error the app cannot see.
 */
export function buildMissingPageDocument(
  options: ArtifactDocumentOptions,
): string {
  return composeArtifactDocument("", options, "missing");
}

/**
 * Stands in for a page the artifact HAS and the host would not hand over, so
 * the app can say that and offer the read again. Without it the shell answers
 * the frame with its error status, whose body is the wire reason - the reader
 * is shown the bare word "failed", which names nothing they can act on.
 */
export function buildUnreachablePageDocument(
  options: ArtifactDocumentOptions,
): string {
  return composeArtifactDocument("", options, "unreachable");
}

function composeArtifactDocument(
  html: string,
  options: ArtifactDocumentOptions,
  artifactPage: ArtifactPageRole,
): string {
  let extraScript: string | undefined;
  if (options.canvas === true) {
    extraScript =
      options.canvasLinks === "native"
        ? buildHtmlSelectionPrelude(options.nonce)
        : buildCanvasPrelude(options.nonce);
  } else {
    extraScript = buildHtmlViewerPrelude();
  }
  const document = buildDocument({
    html:
      options.canvas === true
        ? stampPositions(html, { attributeName: "data-traycer-pos" }).text
        : html,
    ...options,
    extraScript,
    artifactPage,
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
