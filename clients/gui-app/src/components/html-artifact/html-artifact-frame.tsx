import type { ReactNode } from "react";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import type { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import { ArtifactPagesFrame } from "./artifact-pages-frame";

// Kept for the comment backend's context types; regular HTML viewers do not
// mount selection or comment surfaces. Canvas boards own their own comments.
export interface HtmlArtifactFrameContext {
  readonly frame: HTMLIFrameElement | null;
  readonly bridge: SandboxBridgeHost | null;
  readonly servedSha256: string | null;
}

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
