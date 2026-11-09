import type { ReactNode } from "react";
import { ArtifactExpansion } from "@/components/artifacts/artifact-expansion";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import { ArtifactPagesFrame } from "./artifact-pages-frame";

const noop = (): void => undefined;

/** A read-only served artifact: a frame and nothing beside it to raise with it. */
export function HtmlArtifactFrame(props: {
  readonly source: Extract<SandboxSource, { kind: "artifact" }>;
  readonly title: string;
  readonly toolbarControls?: ReactNode;
  readonly menuItems?: ReactNode;
}) {
  return (
    <ArtifactExpansion title={props.title}>
      <ArtifactPagesFrame
        source={props.source}
        title={props.title}
        className="h-full w-full"
        height={null}
        commenting={false}
        onSize={noop}
        onStatus={noop}
        onBridge={null}
        onTextSelection={null}
        onFrame={null}
        renderOverlay={null}
        sourceEquivalent={undefined}
        toolbarControls={props.toolbarControls}
        menuItems={props.menuItems}
      />
    </ArtifactExpansion>
  );
}
