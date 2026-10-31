import type { ReactNode } from "react";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import { ArtifactPagesFrame } from "./artifact-pages-frame";

const noop = (): void => undefined;

export function HtmlArtifactFrame(props: {
  readonly source: Extract<SandboxSource, { kind: "artifact" }>;
  readonly title: string;
  readonly toolbarControls?: ReactNode;
}) {
  return (
    <ArtifactPagesFrame
      source={props.source}
      title={props.title}
      className="h-full w-full"
      height={null}
      pageZoom
      onSize={noop}
      onStatus={noop}
      onBridge={null}
      onTextSelection={null}
      onFrame={null}
      renderOverlay={null}
      toolbarControls={props.toolbarControls}
    />
  );
}
