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
  /** With `canvas`: an html page a reader can comment on, not a board. */
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

/**
 * What each kind of document carries besides its own markup. A page a reader
 * can comment on is a plain page (zoom, pinch, scrollbars, reveals kept in
 * the frame) plus the position stamps and the selection script, so turning
 * the comment tool on or off is a message to the loaded page, never another
 * document. `canvas` is the ordinary bootstrap's board flag, which only a
 * canvas board sets.
 */
function documentParts(
  html: string,
  options: ArtifactDocumentOptions,
): {
  readonly html: string;
  readonly extraScript: string;
  readonly canvas: boolean;
} {
  if (options.canvas !== true)
    return { html, extraScript: buildHtmlViewerPrelude(), canvas: false };
  const stamped = stampPositions(html, {
    attributeName: "data-traycer-pos",
  }).text;
  if (options.canvasLinks === "native")
    return {
      html: stamped,
      // The zoom script first: its touch listeners must precede the
      // selection script's, which keeps touches from the page while the
      // reader comments.
      extraScript:
        buildHtmlViewerPrelude() + buildHtmlSelectionPrelude(options.nonce),
      canvas: false,
    };
  return {
    html: stamped,
    extraScript: buildCanvasPrelude(options.nonce),
    canvas: true,
  };
}

function composeArtifactDocument(
  html: string,
  options: ArtifactDocumentOptions,
  artifactPage: ArtifactPageRole,
): string {
  const document = buildDocument({
    ...options,
    ...documentParts(html, options),
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
