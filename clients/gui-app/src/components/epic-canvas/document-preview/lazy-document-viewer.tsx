/**
 * The one sanctioned way to mount a document viewer (pdf.js for PDF,
 * docx-preview for Word): each is a large dependency that stays out of the
 * main bundle (the pdfmake artifact-export treatment) and loads on the first
 * document of its kind actually opened. The loading fallback matches the
 * asset hook's own presentation so the tile shows one continuous spinner
 * from stream-open to first paint.
 *
 * Also where "this device cannot run the viewer" surfaces. The chunk load
 * failing or the viewer throwing while it mounts both report
 * `onUnavailable`, and the host surface swaps in its placeholder. The file
 * bytes are fine in both cases - this is not the `onRenderFailure` path,
 * which discards them.
 */
import {
  Component,
  lazy,
  Suspense,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { appLogger } from "@/lib/logger";

/** The props every document viewer takes - the tile hands each viewer the same contract. */
export interface DocumentViewerProps {
  /** Blob URL of the validated document bytes (from `useFileAsset`). */
  readonly url: string;
  /** Toolbar caption; surfaces pass their path-like label of choice. */
  readonly fileName: string;
  /** Compact mode drops the toolbar label - for surfaces with their own title. */
  readonly compact: boolean;
  /**
   * Host-surface actions appended to the toolbar (e.g. the tile's Open
   * Externally button), so the viewer bar can be the surface's ONLY bar.
   */
  readonly toolbarActions: ReactNode;
  /**
   * Bytes reached a blob URL but the viewer could not parse them as its
   * format - the exact counterpart of `ImagePreview`'s `onDecodeError`: the
   * caller (the hook's `reportDecodeFailure`) discards the cache entry and
   * flips the tile to the uniform fallback.
   */
  readonly onRenderFailure: () => void;
}

export interface LazyDocumentViewerProps extends DocumentViewerProps {
  /**
   * The viewer chunk failed to load, or the viewer threw while mounting.
   * The surface should show its placeholder; local hosts can offer Open Externally.
   */
  readonly onUnavailable: () => void;
}

type DocumentViewerComponent = (props: DocumentViewerProps) => ReactNode;

export function createLazyDocumentViewer(options: {
  /** Chunk import, cached by React.lazy for this viewer type. */
  readonly load: () => Promise<{ readonly default: DocumentViewerComponent }>;
  /** Log prefix naming the viewer, e.g. `pdf-preview`. */
  readonly logTag: string;
}): (props: LazyDocumentViewerProps) => ReactNode {
  const { load, logTag } = options;

  // Created once per format, outside render. React owns loading and caches
  // both success and failure across tiles. Import failure is the support
  // check for engines that cannot parse or initialize the viewer dependency;
  // no browser-version probes or retry layer are needed.
  const Viewer = lazy(load);

  return function LazyDocumentViewer(props: LazyDocumentViewerProps) {
    const { onUnavailable, ...viewerProps } = props;
    return (
      <DocumentViewerErrorBoundary
        logTag={logTag}
        onUnavailable={onUnavailable}
      >
        <Suspense
          fallback={
            <div className="flex size-full items-center justify-center">
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            </div>
          }
        >
          <Viewer {...viewerProps} />
        </Suspense>
      </DocumentViewerErrorBoundary>
    );
  };
}

interface DocumentViewerErrorBoundaryProps {
  readonly logTag: string;
  readonly onUnavailable: () => void;
  readonly children: ReactNode;
}

interface DocumentViewerErrorBoundaryState {
  readonly failed: boolean;
}

/**
 * Catches rejected imports and viewer render/setup failures. Renders
 * nothing once failed: the parent replaces this subtree with its placeholder.
 */
class DocumentViewerErrorBoundary extends Component<
  DocumentViewerErrorBoundaryProps,
  DocumentViewerErrorBoundaryState
> {
  private reported = false;

  constructor(props: DocumentViewerErrorBoundaryProps) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): DocumentViewerErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (this.reported) return;
    this.reported = true;
    appLogger.errorSummary(
      `[${this.props.logTag}] viewer could not load or mount`,
      { componentStack: info.componentStack ?? null },
      error,
    );
    this.props.onUnavailable();
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
