import { memo } from "react";
import { useStore } from "zustand";

import { ComposerSendButton } from "@/components/home/composer/composer-send-button";
import { useComposerLayout } from "@/lib/layout-overrides";
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
  const order = useComposerLayout().toolbar.right;
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

  return (
    <div className="flex min-w-0 items-center justify-end gap-1">
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
}

export const ComposerToolbarRight = memo(ComposerToolbarRightImpl);
