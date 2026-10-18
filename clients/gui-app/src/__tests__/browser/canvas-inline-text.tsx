import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasInlineTextField } from "@/components/canvas-artifact/canvas-inline-text-field";
import type { CanvasSelection } from "@/components/canvas-artifact/canvas-selection-store";
import { buildArtifactDocument } from "@/lib/sandbox/artifact-serving/artifact-document";
import { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import "@/index.css";

/**
 * THE INLINE TEXT EDITOR OVER A REAL BOARD, MEASURED BY CHROME.
 *
 * A real canvas page (`buildArtifactDocument` with the canvas bootstrap) runs
 * in an iframe. The real `SandboxBridgeHost` asks it to describe the headline,
 * so the element's box and computed styles are what Chrome laid out, not
 * numbers this fixture made up. The production `CanvasInlineTextField` is then
 * placed over the board exactly as the canvas places it: in an overlay that
 * is the iframe's untransformed CSS size, sharing the ancestor transform the
 * board's zoom and position apply.
 * `browser-tests/canvas-inline-text.spec.ts` compares the two in the browser.
 *
 * Query: `zoom` scales the board (default 1), `shifted` moves it, and
 * `bg=transparent` gives the headline no background of its own.
 */
const NONCE = "browser-fixture-nonce";
const BOARD_WIDTH = 640;
const BOARD_HEIGHT = 360;
const HEADLINE = "A headline long enough to wrap onto two lines";
const OPAQUE_BACKGROUND = "rgb(255, 238, 204)";

const params = new URLSearchParams(window.location.search);
const zoom = Number(params.get("zoom") ?? "1");
const shifted = params.has("shifted");
const background =
  params.get("bg") === "transparent" ? "transparent" : OPAQUE_BACKGROUND;

const boardHtml = `<!doctype html><html><head><style>html,body{margin:0}body{font-family:Georgia,serif}h1{position:absolute;left:40px;top:60px;width:300px;margin:0;padding:8px 12px;font-size:28px;line-height:34px;font-weight:700;text-align:center;color:rgb(34,51,68);background:${background}}</style></head><body><h1 id="headline" data-tid="headline">${HEADLINE}</h1></body></html>`;

export function CanvasInlineTextFixture() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [selection, setSelection] = useState<CanvasSelection | null>(null);
  const [value, setValue] = useState(HEADLINE);

  useEffect(() => {
    const iframe = frame.current;
    if (iframe === null) return;
    const bridge = new SandboxBridgeHost({
      document: {
        kind: "served",
        canvas: true,
        nonce: NONCE,
        forwardedShortcuts: [],
      },
      hostContext: {
        theme: "light",
        styles: { variables: {} },
        displayMode: "inline",
        availableDisplayModes: ["inline"],
        platform: "desktop",
      },
      hostVersion: "browser-test",
      post: (message) => iframe.contentWindow?.postMessage(message, "*"),
      events: {
        onStatus: (status) => {
          if (status !== "ready") return;
          void bridge.describeElement({ tid: "headline" }).then((element) => {
            if (element === null) return;
            setSelection({
              artifactId: "browser-fixture",
              boardPath: "boards/home.html",
              page: null,
              servedSha256: "fixture",
              element,
              textRange: null,
            });
          });
        },
        onSize: () => undefined,
        onOpenLink: () => Promise.resolve(false),
        onShortcut: () => undefined,
        onRequestTeardown: () => undefined,
        onScrollGesture: () => undefined,
        onWheel: () => undefined,
      },
      appRequests: null,
    });
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source === iframe.contentWindow) bridge.receive(event.data);
    };
    const onLoad = (): void => bridge.frameLoaded();
    // The listeners are in place before the document exists, so neither the
    // load nor the page's ready message can be missed.
    window.addEventListener("message", onMessage);
    iframe.addEventListener("load", onLoad);
    iframe.srcdoc = buildArtifactDocument(boardHtml, {
      canvas: true,
      policySource: "traycer-sandbox:",
      csp: null,
      theme: {
        appliesToRoot: true,
        colorScheme: "light",
        background: null,
        variables: {},
      },
      nonce: NONCE,
      shortcuts: [],
    });
    return () => {
      window.removeEventListener("message", onMessage);
      iframe.removeEventListener("load", onLoad);
      bridge.dispose();
    };
  }, []);

  return (
    <div style={{ position: "relative", width: 900, height: 600 }}>
      <div
        id="stage"
        data-ready={selection === null ? "false" : "true"}
        style={{
          position: "absolute",
          left: shifted ? 120 : 0,
          top: shifted ? 70 : 0,
          width: BOARD_WIDTH,
          height: BOARD_HEIGHT,
          transform: `scale(${zoom})`,
          transformOrigin: "0 0",
        }}
      >
        <iframe
          id="board"
          ref={frame}
          title="board"
          style={{
            display: "block",
            width: BOARD_WIDTH,
            height: BOARD_HEIGHT,
            border: 0,
            background: "#fff",
          }}
        />
        <div style={{ position: "absolute", inset: 0 }}>
          {selection === null ? null : (
            <CanvasInlineTextField
              selection={selection}
              value={value}
              disabled={false}
              inputRef={null}
              onChange={setValue}
              onKeyDown={() => undefined}
              onBlur={() => undefined}
            >
              {null}
            </CanvasInlineTextField>
          )}
        </div>
      </div>
    </div>
  );
}

const container = document.querySelector("#root");
if (container === null) throw new Error("fixture root missing");
createRoot(container).render(<CanvasInlineTextFixture />);
