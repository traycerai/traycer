import { useEffect, useMemo, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EditorContent } from "@tiptap/react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { SandboxFrame } from "@/components/sandbox/sandbox-frame";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useCollabTileEditor } from "@/components/epic-canvas/renderers/use-collab-tile-editor";
import { ResolvedThemeContext } from "@/providers/use-resolved-theme";
import "@/index.css";
import "@/editor-core/styles/editor.css";

/**
 * A STATUS-BAR STYLE POPOVER BESIDE A REAL ARTIFACT EDITOR AND TWO GUEST
 * FRAMES.
 *
 * The real `PopoverContent` (Radix, which defers its outside-pointerdown
 * dismissal to the gesture's `click`) opens from a button at the foot of the
 * page, or on command through `window.__setUsageOpen`. Above it sit the
 * production collab editor hook over the artifact document bundle, a plain
 * paragraph, a bare sandboxed iframe (the premise: its presses reach nothing
 * here) and the production `SandboxFrame` serving an HTML page, as an HTML
 * artifact tile does. `browser-tests/popover-dismiss-over-editor.spec.ts`
 * opens the popover and presses into each with trusted input.
 */
const DOCUMENT_HTML =
  "<h1>A design</h1><p>The team sandbox already holds a device credential, minted at enrol and renewed hourly.</p><p>A second paragraph of ordinary prose for a drag to cross.</p>";

const GUEST_PAGE_HTML =
  "<!doctype html><p style='font: 16px sans-serif; margin: 24px'>Text inside a sandboxed guest page, a stand-in for an HTML artifact.</p>";

const NO_PERMISSIONS = [] as const;

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

/** The production frame an HTML artifact page renders in. */
export function ArtifactPage(): ReactElement {
  const source = useMemo(
    () => ({ kind: "html", html: GUEST_PAGE_HTML }) as const,
    [],
  );
  return (
    <div data-testid="sandbox-frame" style={{ margin: 16, height: 120 }}>
      <SandboxFrame
        source={source}
        kind="page"
        title="Guest page"
        appName={null}
        networkPolicy="https-only"
        appCsp={null}
        permissions={NO_PERMISSIONS}
        appRequests={null}
        className=""
        height={null}
        onSize={() => undefined}
        onStatus={(status) => {
          document.body.dataset.sandboxStatus = status;
        }}
        onRequestTeardown={() => undefined}
        displayMode="inline"
        onBridge={null}
        pageNavigation={null}
        ref={null}
      />
    </div>
  );
}

export function Fixture(): ReactElement {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    window.__setUsageOpen = setOpen;
    return () => {
      delete window.__setUsageOpen;
    };
  }, []);
  return (
    <div
      style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}
    >
      <EditorPane />
      <p data-testid="plain-paragraph" style={{ margin: 16 }}>
        Plain prose outside the editor, the control for the same gestures.
      </p>
      <iframe
        title="Bare guest page"
        data-testid="guest-frame"
        sandbox="allow-scripts"
        srcDoc={GUEST_PAGE_HTML}
        style={{
          display: "block",
          width: "100%",
          height: 120,
          border: 0,
          margin: 16,
        }}
      />
      <ArtifactPage />
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
            <div style={{ padding: 16 }}>Usage limits body</div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

declare global {
  interface Window {
    __setUsageOpen?: (open: boolean) => void;
  }
}

const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(
  <QueryClientProvider client={new QueryClient()}>
    <ResolvedThemeContext.Provider
      value={{ resolvedTheme: "light", themePreset: "traycer-green" }}
    >
      <Fixture />
    </ResolvedThemeContext.Provider>
  </QueryClientProvider>,
);
