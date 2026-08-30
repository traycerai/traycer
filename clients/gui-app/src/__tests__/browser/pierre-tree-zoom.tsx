import { createRoot } from "react-dom/client";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { PIERRE_FILE_TREE_TRUNCATION_TOLERANCE_CSS } from "@/components/epic-canvas/pierre-tree-theme";

const ROOMY_PATHS = [
  "agent-skills/",
  "cloud-ui-v2/",
  "credit-service/",
  "provider-registry-signer/",
  "redirection-service/",
];

const OVERFLOW_PATHS = [
  "a-deliberately-long-directory-name-that-must-truncate/",
];

export function TreeCase(props: {
  readonly name: "roomy" | "overflow";
  readonly paths: ReadonlyArray<string>;
}) {
  const { model } = useFileTree({
    paths: props.paths,
    density: "compact",
    initialExpansion: "closed",
    unsafeCSS: PIERRE_FILE_TREE_TRUNCATION_TOLERANCE_CSS,
  });

  return (
    <div data-tree-case={props.name}>
      <FileTree model={model} style={{ height: "100%" }} />
    </div>
  );
}

export function Fixture() {
  return (
    <main id="fixtures">
      <TreeCase name="roomy" paths={ROOMY_PATHS} />
      <TreeCase name="overflow" paths={OVERFLOW_PATHS} />
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
