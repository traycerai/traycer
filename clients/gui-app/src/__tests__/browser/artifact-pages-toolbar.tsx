import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ArtifactPagesFrame } from "@/components/html-artifact/artifact-pages-frame";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * THE REAL ARTIFACT PAGES FRAME, FILLING THE PAGE, with one toolbar control so
 * its toolbar shows: `browser-tests/artifact-pages-toolbar.spec.ts` measures
 * where the toolbar sits against the frame's box at a phone and a desktop
 * width. The served document never loads; only the boxes are read.
 */
const queryClient = new QueryClient();

export function ArtifactPagesToolbarFixture(): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <ArtifactPagesFrame
        source={{
          kind: "artifact",
          artifactId: "artifact-a1",
          treePath: "site",
          entryPath: "index.html",
          manifest: {
            files: {
              "index.html": {
                sha256: "sha-index",
                byteLength: 10,
                mediaType: "text/html; charset=utf-8",
                status: "published",
              },
            },
          },
          readSpan: () => Promise.resolve({ unavailable: "failed" }),
          resolveOutsideReference: () => null,
        }}
        title="Report"
        className="h-full w-full"
        height={null}
        pageZoom={false}
        onSize={() => undefined}
        onStatus={() => undefined}
        onBridge={null}
        onTextSelection={null}
        onFrame={null}
        renderOverlay={null}
        sourceEquivalent={undefined}
        toolbarControls={<button type="button">Probe control</button>}
      />
    </QueryClientProvider>
  );
}

const root = document.querySelector("#root");
if (root === null) throw new Error("fixture root missing");
createRoot(root).render(<ArtifactPagesToolbarFixture />);
