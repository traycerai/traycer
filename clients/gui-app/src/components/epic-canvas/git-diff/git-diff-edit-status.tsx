import type { ReactNode } from "react";
import {
  FileAutosaveStatus,
  FileStatusPill,
  type FileStatusAppearance,
} from "@/components/diff/file-autosave-status";
import type { GitDiffEditingModel } from "./git-diff-editing";

export function GitDiffEditStatusContent(props: {
  readonly editing: GitDiffEditingModel;
  readonly appearance: FileStatusAppearance;
}): ReactNode {
  const { editing } = props;
  if (editing.loading && editing.canOfferEdit && !editing.active) {
    return (
      <FileStatusPill
        label="Preparing editor"
        description="Loading the full file contents before editing starts."
        tone="active"
        busy
        appearance={props.appearance}
      />
    );
  }
  if (editing.notice !== null) {
    return (
      <FileStatusPill
        label="Editor unavailable"
        description={editing.notice}
        tone="danger"
        busy={false}
        appearance={props.appearance}
      />
    );
  }
  return (
    <>
      {editing.stale ? (
        <FileStatusPill
          label="Worktree changed"
          description="This editor keeps its pinned comparison; saving will verify the file before replacing it."
          tone="warning"
          busy={false}
          appearance={props.appearance}
        />
      ) : null}
      <FileAutosaveStatus
        appearance={props.appearance}
        state={editing.state}
        onRetry={editing.retry}
        onKeepMine={editing.keepMine}
        onUseDisk={editing.useDisk}
      />
    </>
  );
}
