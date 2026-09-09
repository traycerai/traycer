import { useCallback, useMemo, useState } from "react";
import type { Editor } from "@tiptap/core";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";

import type { ArtifactQuoteAction } from "@/editor-core";

import {
  snapshotArtifactQuote,
  type ArtifactQuoteSnapshot,
} from "./artifact-quote-snapshot";
import {
  useArtifactQuoteActions,
  type ArtifactQuoteActions,
} from "./use-artifact-quote-actions";

export interface ArtifactQuoteSurface {
  /** `null` for a tile whose content cannot be quoted, or before the editor. */
  readonly action: ArtifactQuoteAction | null;
  /** The frozen excerpt while the picker is open; `null` when it is not. */
  readonly snapshot: ArtifactQuoteSnapshot | null;
  /** Whether the picker owns the selection right now. */
  readonly isOpen: boolean;
  readonly actions: ArtifactQuoteActions;
  readonly dismiss: () => void;
}

/**
 * Everything the tile needs to offer "Send to chat" on a selection, in one
 * place: the toolbar action, the frozen excerpt while a target is being
 * chosen, and the send/dismiss callbacks.
 *
 * Tile-local by construction - a sibling pane editing the same artifact keeps
 * its own excerpt, and no chat-roster subscription exists until the picker
 * actually mounts.
 */
export function useArtifactQuoteSurface(args: {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly artifactId: string;
  /** `null` for a tile kind that cannot be quoted (chat). */
  readonly artifactKind: EpicArtifactKind | null;
  readonly editor: Editor | null;
}): ArtifactQuoteSurface {
  const { epicId, viewTabId, artifactId, artifactKind, editor } = args;
  const [snapshot, setSnapshot] = useState<ArtifactQuoteSnapshot | null>(null);

  const action = useMemo<ArtifactQuoteAction | null>(() => {
    if (artifactKind === null || editor === null) return null;
    return {
      onStart: () => {
        setSnapshot(snapshotArtifactQuote(editor.state));
      },
    };
  }, [artifactKind, editor]);

  const actions = useArtifactQuoteActions({
    epicId,
    viewTabId,
    artifactId,
    // Only reached through `action`, which is null unless the kind is real.
    artifactKind: artifactKind ?? "spec",
  });

  const dismiss = useCallback(() => {
    setSnapshot(null);
    // The picker took focus; give it back so the selection - still there -
    // gets its bubble bar again.
    editor?.commands.focus(undefined, { scrollIntoView: false });
  }, [editor]);

  return { action, snapshot, isOpen: snapshot !== null, actions, dismiss };
}
