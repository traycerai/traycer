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
 * Builds a legacy `<traycer-*>` reference component. The four reference tags
 * (`spec` / `ticket` / `chat` / `epic`) are byte-identical apart from the icon,
 * the embedded node-id attribute, and the `refKind`, so they share one
 * config-driven body.
 *
 * - `idAttr` is the `data-*-id` attribute holding the embedded node id, or
 *   `null` for `<traycer-epic>`, which references no node.
 * - `requiresNode` mirrors the open hook: `true` for node refs (a missing id
 *   degrades to plain text), `false` for the epic ref.
 *
 * Every component renders a clickable chip that opens by its embedded id
 * (render-time only - no migration); without a resolvable id / epic context the
 * chip degrades to the plain label text.
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
