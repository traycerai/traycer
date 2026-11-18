import { useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { buildDocxFixture } from "@traycer-clients/shared/test-fixtures/docx-document";
import DocxPreview from "@/components/epic-canvas/docx-preview/docx-preview";
import { TileSelectAllBridge } from "@/components/epic-canvas/tile-select-all-bridge";
import { useTileFindStore } from "@/stores/tile-find";
import { createAppQueryClient } from "@/lib/query-client";
import type {
  TileFindAdapter,
  TileFindCapability,
  TileFindStateSnapshot,
} from "@/stores/tile-find";
import "@/index.css";

const EMPTY_SNAPSHOT: TileFindStateSnapshot = {
  requestId: 0,
  status: "idle",
  capabilities: new Set<TileFindCapability>(["find"]),
  query: "",
  matchCase: false,
  replaceText: "",
  current: 0,
  total: 0,
  coverageMessage: null,
  errorMessage: null,
  activeUnitId: null,
  exactHighlight: "none",
};

function makeTileFindAdapter(tileInstanceId: string): TileFindAdapter {
  const listeners = new Set<() => void>();
  return {
    tileInstanceId,
    tileKind: "workspace-file",
    replace: null,
    getSnapshot: () => EMPTY_SNAPSHOT,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    search: () => {
      for (const listener of listeners) listener();
    },
    next: () => undefined,
    previous: () => undefined,
    clear: () => undefined,
  };
}

function makeDocxUrl(label: "ALPHA" | "BETA"): string {
  const bytes = buildDocxFixture({
    pages: [
      {
        paragraphs: [
          [
            `${label}-SEARCH`,
            ` appears on page one in two Word runs for ${label}.`,
          ],
        ],
      },
      {
        paragraphs: [
          [
            `${label} page two has enough text to make page navigation visible.`,
          ],
        ],
      },
      {
        paragraphs: [
          [`${label} page three is the final page in this real docx fixture.`],
        ],
      },
    ],
    inlineImagePng: null,
  });
  return URL.createObjectURL(
    new Blob([bytes.slice().buffer], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
  );
}

const urls = {
  alpha: makeDocxUrl("ALPHA"),
  beta: makeDocxUrl("BETA"),
};
const queryClient = createAppQueryClient();

interface WordTileProps {
  readonly id: "alpha" | "beta";
  readonly label: "ALPHA" | "BETA";
}

export function WordTile({ id, label }: WordTileProps): ReactNode {
  useEffect(() => {
    const unregister = useTileFindStore.getState().registerTarget({
      tileInstanceId: id,
      contentId: `word-${id}`,
      viewTabId: "word-preview-browser-regression",
      tileId: id,
      epicId: "word-preview-browser-regression",
      tileKind: "workspace-file",
      // Keep alpha as the active owner while beta remains mounted. This lets
      // the keyboard select-all assertion prove that the second shadow tree
      // is excluded from the active tile's range.
      isEligible: id === "alpha",
      adapter: makeTileFindAdapter(id),
    });
    return unregister;
  }, [id]);

  return (
    <section
      data-word-tile={id}
      data-tile-instance-id={id}
      aria-label={`${label} Word document`}
    >
      <DocxPreview
        url={urls[id]}
        fileName={`${label.toLowerCase()}.docx`}
        compact={false}
        toolbarActions={null}
        onRenderFailure={() => {
          document
            .getElementById("test-state")
            ?.setAttribute(`data-${id}-render-failed`, "true");
        }}
      />
    </section>
  );
}

export function Fixture(): ReactNode {
  useEffect(() => {
    return () => {
      URL.revokeObjectURL(urls.alpha);
      URL.revokeObjectURL(urls.beta);
      useTileFindStore.getState().resetForTests();
    };
  }, []);

  return (
    <main id="fixtures">
      <TileSelectAllBridge />
      <output id="test-state" />
      <WordTile id="alpha" label="ALPHA" />
      <WordTile id="beta" label="BETA" />
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing fixture root");
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <Fixture />
  </QueryClientProvider>,
);
