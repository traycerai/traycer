import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { EditorContent } from "@tiptap/react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useCollabTileEditor } from "@/components/epic-canvas/renderers/use-collab-tile-editor";
import { useGuestFramePressRelay } from "@/hooks/ui/use-guest-frame-press-relay";
import "@/index.css";
import "@/editor-core/styles/editor.css";

/**
 * A STATUS-BAR STYLE POPOVER BESIDE A REAL ARTIFACT EDITOR AND A GUEST FRAME.
 *
 * The real `PopoverContent` (Radix, which defers its outside-pointerdown
 * dismissal to the gesture's `click`) opens from a button at the foot of the
 * page. Above it sit the production collab editor hook over the artifact
 * document bundle, a plain paragraph, and a sandboxed iframe standing in for
 * an HTML artifact page, wired to the production press relay when the page
 * is loaded with `?relay=on`. `browser-tests/popover-dismiss-over-editor.spec.ts`
 * opens the popover and presses into each with trusted input.
 */
const DOCUMENT_HTML =
  "<h1>A design</h1><p>The team sandbox already holds a device credential, minted at enrol and renewed hourly.</p><p>A second paragraph of ordinary prose for a drag to cross.</p>";

export function EditorPane(): ReactElement {
  const doc = useMemo(() => new Y.Doc(), []);
  const fragment = useMemo(() => doc.getXmlFragment("default"), [doc]);
  const awareness = useMemo(() => new Awareness(doc), [doc]);
  const user = useMemo(() => ({ name: "U", color: "#ef4444" }), []);
  const editor = useCollabTileEditor({
    doc,
    fragment,
    awareness,
    editable: true,
    user,
    onCommentShortcut: null,
    anchorScope: null,
    placeholderText: "Write something",
    titlePlaceholderText: "Title",
  });
  useEffect(() => {
    if (editor === null) return;
    if (editor.state.doc.textContent.length > 0) return;
    editor.commands.setContent(DOCUMENT_HTML);
  }, [editor]);
  return (
    <div data-testid="editor-pane" style={{ margin: 16, minHeight: 240 }}>
      {editor === null ? null : <EditorContent editor={editor} />}
    </div>
  );
}

/**
 * A sandboxed guest frame like the HTML artifact tile's: its presses never
 * reach this document. `relay=on` wires the production press relay to it.
 */
export function GuestFrame(): ReactElement {
  const relay = new URLSearchParams(location.search).get("relay") === "on";
  const relayRef = useRef<HTMLIFrameElement | null>(null);
  useGuestFramePressRelay(relayRef);
  return (
    <iframe
      ref={(node) => {
        relayRef.current = relay ? node : null;
      }}
      title="Guest page"
      data-testid="guest-frame"
      sandbox="allow-scripts"
      srcDoc="<!doctype html><p style='font: 16px sans-serif; margin: 24px'>Text inside a sandboxed guest page, a stand-in for an HTML artifact.</p>"
      style={{
        display: "block",
        width: "100%",
        height: 120,
        border: 0,
        margin: 16,
      }}
    />
  );
}

export function Fixture(): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}
    >
      <EditorPane />
      <p data-testid="plain-paragraph" style={{ margin: 16 }}>
        Plain prose outside the editor, the control for the same gestures.
      </p>
      <GuestFrame />
      <div style={{ marginTop: "auto", padding: 16 }}>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button" data-testid="popover-trigger">
              Open usage
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            role="dialog"
            aria-label="Usage limits"
            layout="panel"
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <div style={{ padding: 16, width: 240 }}>Usage limits body</div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(<Fixture />);
