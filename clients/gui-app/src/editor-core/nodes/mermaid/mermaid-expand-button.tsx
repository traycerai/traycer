import type { ReactNode } from "react";

interface MermaidExpandButtonProps {
  readonly ariaLabel: string;
  readonly children: ReactNode;
  readonly onExpand: () => void;
}

/** Makes the rendered diagram itself the fullscreen affordance. */
export function MermaidExpandButton(props: MermaidExpandButtonProps) {
  return (
    <button
      type="button"
      className="tc-node-mermaid__expand"
      aria-label={`Expand diagram: ${props.ariaLabel}`}
      onClick={props.onExpand}
    >
      <span className="tc-node-mermaid__svg">{props.children}</span>
    </button>
  );
}
