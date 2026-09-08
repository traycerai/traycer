/**
 * The viewer half of the unified file rendering core (D27): sniffed media type
 * -> the component that renders it, plus the handful of capabilities a host
 * surface has to branch on.
 *
 * ## A plain map, deliberately
 *
 * No plugin machinery, no runtime registration, no lazy-loading framework
 * beyond the `React.lazy` the PDF viewer already owns. Six families, one
 * record, one resolver. A new family is an edit here, which is what makes the
 * fallback chain readable in one screen.
 *
 * ## Registered AS-IS
 *
 * The existing viewers keep their own prop contracts - this ticket does not
 * port them onto a common `FileViewerProps` (that is ticket 27, deliberately
 * the last wave and allowed to slip). So {@link FileViewerEntry} is a union
 * discriminated by `family`, each arm naming the component it actually holds:
 * a consumer switches on `family` and passes the props that viewer already
 * takes. When ticket 27 unifies them, this union collapses to one arm and
 * every `switch` collapses with it.
 */
import { BinaryPlaceholder } from "@/components/epic-canvas/binary-placeholder";
import { ImagePreview } from "@/components/epic-canvas/image-preview/image-preview";
import { PdfPreviewLazy } from "@/components/epic-canvas/pdf-preview/pdf-preview-lazy";
import { VideoPreview } from "@/components/epic-canvas/video-preview/video-preview";
import { WorkspaceFileRenderer } from "@/components/epic-canvas/workspace-file/workspace-file-renderer";
import type { FileByteSourceKind } from "@/lib/files/byte-source";
import {
  mediaTypeFamily,
  type ViewerFamily,
} from "@/lib/files/media-type-family";

/**
 * What a surface must know about a viewer BEFORE it has bytes - which is the
 * whole reason these are capabilities rather than props.
 */
export interface FileViewerCapabilities {
  /**
   * The viewer takes a remote url straight in an element that fetches its own
   * bytes, so `useFileBytes` may hand it `delivery: "url"` (D10). Mirrors
   * `familyAcceptsDirectUrl` in `media-type-family.ts`, which is what the byte
   * half reads - the two must agree, and a family is the only thing either
   * consults, so they cannot drift per-file.
   */
  readonly acceptsDirectUrl: boolean;
  /** The viewer renders decoded TEXT, not a `src` - the caller must read the blob. */
  readonly needsText: boolean;
  /**
   * An "Open in browser" action belongs beside this viewer (D32): HTML opens
   * on the epic's own token-scoped loopback static server, never from the cloud
   * origin as `text/html`. Only an epic-file source has such a server, which is
   * why {@link resolveViewer} takes the source kind.
   */
  readonly opensInBrowser: boolean;
}

export type FileViewerEntry =
  | {
      readonly family: "image";
      readonly capabilities: FileViewerCapabilities;
      readonly component: typeof ImagePreview;
    }
  | {
      readonly family: "video";
      readonly capabilities: FileViewerCapabilities;
      readonly component: typeof VideoPreview;
    }
  | {
      readonly family: "pdf";
      readonly capabilities: FileViewerCapabilities;
      readonly component: typeof PdfPreviewLazy;
    }
  | {
      readonly family: "text";
      readonly capabilities: FileViewerCapabilities;
      readonly component: typeof WorkspaceFileRenderer;
    }
  | {
      readonly family: "html";
      readonly capabilities: FileViewerCapabilities;
      readonly component: typeof WorkspaceFileRenderer;
    }
  | {
      readonly family: "binary";
      readonly capabilities: FileViewerCapabilities;
      readonly component: typeof BinaryPlaceholder;
    };

type FileViewerRegistry = {
  readonly [Family in ViewerFamily]: Extract<
    FileViewerEntry,
    { readonly family: Family }
  >;
};

/**
 * The fallback chain of D27, in order: image, video, pdf, text/code, html,
 * binary. `binary` is terminal - an unknown media type resolves to it rather
 * than throwing, because a file with a download affordance is a correct
 * rendering of "we don't know what this is" and a throw is not.
 */
export const VIEWER_REGISTRY: FileViewerRegistry = {
  image: {
    family: "image",
    capabilities: {
      acceptsDirectUrl: true,
      needsText: false,
      opensInBrowser: false,
    },
    component: ImagePreview,
  },
  // `acceptsDirectUrl` is what keeps a clip out of `fetch()`: the element
  // owns its own `Range` requests and its seeking, and the desktop CSP grew a
  // `media-src` so a `<video>` src is not judged by `default-src 'self'`.
  video: {
    family: "video",
    capabilities: {
      acceptsDirectUrl: true,
      needsText: false,
      opensInBrowser: false,
    },
    component: VideoPreview,
  },
  pdf: {
    family: "pdf",
    capabilities: {
      acceptsDirectUrl: false,
      needsText: false,
      opensInBrowser: false,
    },
    component: PdfPreviewLazy,
  },
  text: {
    family: "text",
    capabilities: {
      acceptsDirectUrl: false,
      needsText: true,
      opensInBrowser: false,
    },
    component: WorkspaceFileRenderer,
  },
  // D32: HTML is the CODE viewer - the same component `text` resolves to -
  // plus the "Open in browser" action of `html-file-actions.tsx`, which is the
  // one arm where the bytes are allowed to RUN, on the epic's own loopback
  // static server. There is no preview arm and no iframe; `opensInBrowser`
  // below is the registry default and {@link resolveViewer} raises it for the
  // one source kind that has such a server.
  html: {
    family: "html",
    capabilities: {
      acceptsDirectUrl: false,
      needsText: true,
      opensInBrowser: false,
    },
    component: WorkspaceFileRenderer,
  },
  binary: {
    family: "binary",
    capabilities: {
      acceptsDirectUrl: false,
      needsText: false,
      opensInBrowser: false,
    },
    component: BinaryPlaceholder,
  },
};

/**
 * The viewer for one file. `sourceKind` decides exactly one thing today - the
 * "Open in browser" affordance, which exists only where a loopback static
 * server does (D32) - and is a parameter rather than a caller-side `&&` so the
 * rule lives with the registry that states it.
 */
export function resolveViewer(
  mediaType: string,
  sourceKind: FileByteSourceKind,
): FileViewerEntry {
  const entry = VIEWER_REGISTRY[mediaTypeFamily(mediaType)];
  if (entry.family !== "html") return entry;
  return {
    ...entry,
    capabilities: {
      ...entry.capabilities,
      opensInBrowser: sourceKind === "epic-file",
    },
  };
}
