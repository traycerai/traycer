/**
 * The only sanctioned entry to `PdfPreview`: pdf.js is a ~1-2 MB dependency
 * that stays out of the main bundle (the pdfmake artifact-export treatment)
 * and loads on the first PDF actually opened. The Suspense fallback matches
 * the asset hook's own loading presentation so the tile shows one continuous
 * spinner from stream-open to first page paint.
 */
import { lazy, Suspense, type ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { PdfPreviewProps } from "./pdf-preview";

const PdfPreview = lazy(() => import("./pdf-preview"));

export function PdfPreviewLazy(props: PdfPreviewProps): ReactNode {
  return (
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
      <PdfPreview {...props} />
    </Suspense>
  );
}
