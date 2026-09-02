/**
 * The only sanctioned entry to `PdfPreview`: pdf.js is a ~1-2 MB dependency
 * that stays out of the main bundle (the pdfmake artifact-export treatment)
 * and loads on the first PDF actually opened. The loading fallback matches
 * the asset hook's own presentation so the tile shows one continuous
 * spinner from stream-open to first page paint.
 *
 * Also where "this device cannot run the viewer" surfaces. The chunk load
 * failing (`pdf-preview-loader.ts` explains why that IS the support check)
 * or the viewer throwing while it mounts both report `onUnavailable`, and
 * the host surface swaps in its placeholder with
 * `PDF_VIEWER_UNAVAILABLE_REASON`. The file bytes are fine in both cases -
 * this is not the `onRenderFailure` path, which discards them.
 */
import {
  Component,
  useEffect,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { appLogger } from "@/lib/logger";
import type { PdfPreviewProps } from "./pdf-preview";
import { loadPdfPreview } from "./pdf-preview-loader";

/** Placeholder copy for a viewer that could not load or start here. */
export const PDF_VIEWER_UNAVAILABLE_REASON =
  "The PDF viewer could not be loaded on this device.";

type PdfPreviewComponent = (props: PdfPreviewProps) => ReactNode;

export interface PdfPreviewLazyProps extends PdfPreviewProps {
  /**
   * The viewer chunk failed to load, or the viewer threw while mounting.
   * The surface should show its placeholder (Open Externally still works).
   */
  readonly onUnavailable: () => void;
}

export function PdfPreviewLazy(props: PdfPreviewLazyProps): ReactNode {
  const { onUnavailable, ...viewerProps } = props;
  const [PdfPreview, setPdfPreview] = useState<PdfPreviewComponent | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void loadPdfPreview().then(
      (module) => {
        if (!cancelled) setPdfPreview(() => module.default);
      },
      (error: unknown) => {
        if (cancelled) return;
        appLogger.errorSummary(
          "[pdf-preview] viewer chunk failed to load",
          {},
          error,
        );
        onUnavailable();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [onUnavailable]);

  if (PdfPreview === null) {
    return (
      <div className="flex size-full items-center justify-center">
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      </div>
    );
  }
  return (
    <PdfPreviewErrorBoundary onUnavailable={onUnavailable}>
      <PdfPreview {...viewerProps} />
    </PdfPreviewErrorBoundary>
  );
}

interface PdfPreviewErrorBoundaryProps {
  readonly onUnavailable: () => void;
  readonly children: ReactNode;
}

interface PdfPreviewErrorBoundaryState {
  readonly failed: boolean;
}

/**
 * Catches the viewer throwing during render or its setup effects (a pdf.js
 * API missing at construction time, past the module-scope failures the
 * loader already sees). Renders nothing once failed: the parent has been
 * told and replaces this subtree with its placeholder.
 */
class PdfPreviewErrorBoundary extends Component<
  PdfPreviewErrorBoundaryProps,
  PdfPreviewErrorBoundaryState
> {
  constructor(props: PdfPreviewErrorBoundaryProps) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): PdfPreviewErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    appLogger.errorSummary(
      "[pdf-preview] viewer threw while mounting",
      { componentStack: info.componentStack ?? null },
      error,
    );
    this.props.onUnavailable();
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
