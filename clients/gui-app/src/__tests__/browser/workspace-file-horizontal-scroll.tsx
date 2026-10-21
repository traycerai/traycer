import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceFileRenderer } from "@/components/epic-canvas/workspace-file/workspace-file-renderer";
import { useDiffClickToEdit } from "@/components/diff/use-diff-click-to-edit";
import { DEFAULT_THEME_PRESET } from "@/lib/theme-presets";
import { ResolvedThemeContext } from "@/providers/use-resolved-theme";
import "@/index.css";

const FILE_NAME = "src/long-lines.ts";
const LINE_COUNT = 120;
// Far wider than the tile, so the code area has a real horizontal range.
const LONG_LINE_SEGMENT = "const longSegment = 'wide wide wide wide wide';";
const CONTENT = Array.from(
  { length: LINE_COUNT },
  (_unused, index) =>
    `const line${String(index)} = '${LONG_LINE_SEGMENT.repeat(12)}';`,
).join("\n");

function noop(): void {}

export function WorkspaceFileHorizontalScrollFixture() {
  const [wordWrap, setWordWrap] = useState(false);
  const editAdapter = useDiffClickToEdit({
    surfaceId: "workspace-file-horizontal-scroll",
    enabled: false,
    active: false,
    onActivate: () => Promise.resolve({ kind: "rejected" }),
    onActivationError: noop,
    onChange: noop,
    onBlur: noop,
    onSaveShortcut: noop,
  });
  useLayoutEffect(() => {
    window.__workspaceFileHorizontalScrollProbe = { setWordWrap };
  }, []);
  return (
    <ResolvedThemeContext.Provider
      value={{ resolvedTheme: "light", themePreset: DEFAULT_THEME_PRESET }}
    >
      {/* The tile body's own scroller classes, in a box of known size. */}
      <div className="flex" style={{ width: 600, height: 320 }}>
        <div
          data-testid="workspace-file-scroller"
          className="relative min-h-0 flex-1 overflow-auto"
        >
          <WorkspaceFileRenderer
            content={CONTENT}
            fileName={FILE_NAME}
            language="typescript"
            editing={false}
            editAdapter={editAdapter}
            wordWrap={wordWrap}
            revealLine={null}
            revealNonce={null}
            findTarget={null}
            onRevealConsumed={noop}
            fileIdentity={null}
          />
        </div>
      </div>
    </ResolvedThemeContext.Provider>
  );
}

declare global {
  interface Window {
    __workspaceFileHorizontalScrollProbe: {
      setWordWrap: (wordWrap: boolean) => void;
    };
  }
}

const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(<WorkspaceFileHorizontalScrollFixture />);
