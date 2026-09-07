import { type ReactNode } from "react";
import { TraycerReferenceChip } from "./traycer-reference-chip";
import { useTraycerReferenceOpenHandler } from "./use-traycer-reference-open";

interface TraycerReferenceProps {
  "data-epic-id"?: string;
  "data-title"?: string;
  children?: ReactNode;
  [key: string]: unknown;
}

/**
 * Factory for legacy `<traycer-*>` chips. Missing id / epic context degrades to plain text.
 */
export function makeTraycerReference(config: {
  readonly icon: ReactNode;
  readonly idAttr: string | null;
  readonly refKind: "spec" | "ticket" | "chat" | "epic";
  readonly requiresNode: boolean;
}) {
  return function TraycerReference(props: TraycerReferenceProps) {
    const rawNodeId = config.idAttr === null ? undefined : props[config.idAttr];
    const { onOpen, sameEpicNodeRef } = useTraycerReferenceOpenHandler({
      epicId: props["data-epic-id"],
      nodeId: typeof rawNodeId === "string" ? rawNodeId : undefined,
      requiresNode: config.requiresNode,
    });
    return (
      <TraycerReferenceChip
        icon={config.icon}
        title={props["data-title"]}
        refKind={config.refKind}
        onOpen={onOpen}
        sameEpicNodeRef={sameEpicNodeRef}
        epicId={props["data-epic-id"]}
      >
        {props.children}
      </TraycerReferenceChip>
    );
  };
}
