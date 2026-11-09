import { useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ArtifactExpansion } from "@/components/artifacts/artifact-expansion";
import { useArtifactEscape } from "@/components/artifacts/artifact-expanded-context";
import { ArtifactPagesFrame } from "@/components/html-artifact/artifact-pages-frame";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * THE REAL ARTIFACT PAGES FRAME inside the real expansion, with a button and a
 * frame of its own behind it and a way to raise a dialog outside it:
 * `browser-tests/artifact-expansion.spec.ts` reads what jsdom cannot decide
 * about the expanded surface - that the top layer paints and hit-tests above
 * the page behind it, that the rest of the document goes INERT so neither Tab
 * nor a programmatic focus can reach it, that Tab cycles inside the surface
 * both ways, that a menu raised inside it is visible and clickable there, that
 * focus starts and returns where it should, that a dialog raised elsewhere
 * lowers the surface and is then reachable, and that the surface is the SAME
 * instance before and after.
 *
 * The served document never loads here (it needs the desktop runner); only
 * boxes, hit testing, focus and the surface's own state are read.
 */
const queryClient = new QueryClient();

/** Raises a dialog OUTSIDE the surface, as an approval or a confirm does. */
function raiseOutsideDialog(): void {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("data-outside-dialog", "");
  const answer = document.createElement("button");
  answer.type = "button";
  answer.id = "outside-answer";
  answer.textContent = "Answer";
  // Pressed after the surface has yielded. A confirm that needs the reader is
  // only any use if they can reach it, and everything outside a modal surface
  // is inert, so this press is the proof that the yield actually happened.
  answer.addEventListener("click", () => {
    answer.textContent = "Answered";
  });
  dialog.append(answer);
  document.body.append(dialog);
}

/**
 * Rides inside the surface as one of its toolbar controls, so its state is the
 * surface's state: if expanding re-mounted the surface - which is what it used
 * to do - the press count would go back to zero.
 *
 * `useArtifactEscape` is the production hook a canvas tool uses to take the
 * first Escape, so the ordering the spec reads is the real one.
 */
function ToolbarProbe(props: { readonly picked: boolean }): ReactElement {
  const [presses, setPresses] = useState(0);
  const [armed, setArmed] = useState(false);
  useArtifactEscape(() => {
    if (!armed) return false;
    setArmed(false);
    return true;
  });
  return (
    <>
      <button
        type="button"
        id="probe-control"
        onClick={() => setPresses((count) => count + 1)}
      >
        {`Presses ${String(presses)}`}
      </button>
      <button type="button" id="probe-arm" onClick={() => setArmed(true)}>
        {armed ? "Local mode on" : "Local mode off"}
      </button>
      <span id="probe-picked">{props.picked ? "Picked" : "Not picked"}</span>
    </>
  );
}

export function ArtifactExpansionFixture(): ReactElement {
  const [picked, setPicked] = useState(false);
  return (
    <QueryClientProvider client={queryClient}>
      {/* Earlier than the surface in DOM order and carrying no z-index, so the
          spec can aim real input at it and ask who receives the press. */}
      <button type="button" id="behind">
        Behind the surface
      </button>
      <button type="button" id="raise-dialog" onClick={raiseOutsideDialog}>
        Raise outside dialog
      </button>
      {/* A document of its own behind the surface, which is how an artifact
          sits behind the next one. Focus crossing into a frame shows up as the
          frame element becoming this document's `activeElement`, so the spec
          can ask whether Tab or a programmatic focus ever got inside one. */}
      <iframe
        id="behind-frame"
        title="Behind the surface"
        srcDoc='<!doctype html><button type="button" id="inner">Inner control</button>'
        className="h-16 w-48"
      />
      {/* The chat's message row carries `[contain:layout_paint_style]`
          (`chat-timeline.tsx`), and paint containment makes an element a
          containing block for its fixed descendants AND clips them - so a
          surface raised from a row has to escape it through the top layer,
          not through the cascade. Mirrored here because a flat fixture cannot
          tell the two apart. */}
      <div className="h-[600px] w-full [contain:layout_paint_style]">
        <ArtifactExpansion title="Report">
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
            commenting={false}
            onSize={() => undefined}
            onStatus={() => undefined}
            onBridge={null}
            onTextSelection={null}
            onFrame={null}
            renderOverlay={null}
            sourceEquivalent={undefined}
            toolbarControls={<ToolbarProbe picked={picked} />}
            menuItems={
              <DropdownMenuItem onSelect={() => setPicked(true)}>
                Probe action
              </DropdownMenuItem>
            }
          />
        </ArtifactExpansion>
      </div>
    </QueryClientProvider>
  );
}

const root = document.querySelector("#root");
if (root === null) throw new Error("fixture root missing");
createRoot(root).render(<ArtifactExpansionFixture />);
