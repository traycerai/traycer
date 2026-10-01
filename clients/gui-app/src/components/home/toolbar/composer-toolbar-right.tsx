import { memo } from "react";
import { useStore } from "zustand";

import { ComposerSendButton } from "@/components/home/composer/composer-send-button";
import { LAYOUT_CLUSTER_ATTRIBUTE } from "@/components/layout-editor/canvas/region-drag";
import { LayoutClusterContextMenu } from "@/components/layout-editor/region-quick-verbs";
import { useArrangementValue } from "@/lib/layout-overrides";
import {
  renderToolbarItem,
  type ComposerToolbarItemsProps,
} from "@/components/home/toolbar/composer-toolbar-item";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";

interface ComposerToolbarRightProps extends ComposerToolbarItemsProps {
  readonly canSubmit: boolean;
  readonly attachmentPending: boolean;
  readonly onSubmit: () => void;
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly stopDisabled: boolean;
  readonly onStopTurn: (() => void) | null;
  readonly composerDisabledHint: string | null;
}

function ComposerToolbarRightImpl(props: ComposerToolbarRightProps) {
  const order = useArrangementValue("toolbarRight");
  // Block sending until the model slug resolves to a concrete value - an
  // empty slug is the transient "catalog still loading" marker and must never
  // reach the wire as `model: ""`. Gating HERE (instead of in the host
  // composer's `canSubmit`) keeps the composer from re-rendering when the
  // catalog resolves; the submit handlers re-check via `store.getState()`.
  const modelResolved = useStore(
    props.store,
    (s) => s.selection.modelSlug.length > 0,
  );
  const canSubmitResolved = props.canSubmit ? modelResolved : false;

  const cluster = (
    <div
      {...{ [LAYOUT_CLUSTER_ATTRIBUTE]: "" }}
      className="flex min-w-0 items-center justify-end gap-1"
    >
      {order.map((id) => (
        <span key={id} className="contents" data-testid={`toolbar-item-${id}`}>
          {renderToolbarItem(id, props)}
        </span>
      ))}
      <span className="contents" data-testid="toolbar-item-send">
        <ComposerSendButton
          canSubmit={canSubmitResolved}
          attachmentPending={props.attachmentPending}
          onSubmit={props.onSubmit}
          activeTurnStatus={props.activeTurnStatus}
          stopDisabled={props.stopDisabled}
          onStopTurn={props.onStopTurn}
          disabledHint={props.composerDisabledHint}
        />
      </span>
    </div>
  );

  // One menu for the strip, naming whichever item the pointer was over
  // (G3-10); the send button is no region, so a right-click on it opens
  // nothing. The presentation copy carries the menu too - it is the sample
  // workspace's toolbar, which is the one the user right-clicks while
  // customizing (L-129).
  return <LayoutClusterContextMenu>{cluster}</LayoutClusterContextMenu>;
}

export const ComposerToolbarRight = memo(ComposerToolbarRightImpl);
