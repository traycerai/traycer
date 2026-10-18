import {
  isEpicArtifactKind,
  type EpicNodeKind,
} from "@/lib/artifacts/node-display";

// HTML, canvas and file creation needs a source file; this menu authors Markdown only.
export const ADDABLE_TYPES: ReadonlyArray<EpicNodeKind> = [
  "chat",
  "ticket",
  "spec",
  "story",
  "review",
  "terminal",
];

// Derived from `ADDABLE_TYPES` so a newly-added kind stays excluded from the
// artifacts panel until the family nesting rules explicitly opt it in.
export const CHAT_PANEL_EXCLUDED_TYPES: ReadonlyArray<EpicNodeKind> =
  ADDABLE_TYPES.filter((type) => type !== "chat");

export const ARTIFACT_PANEL_EXCLUDED_TYPES: ReadonlyArray<EpicNodeKind> =
  ADDABLE_TYPES.filter((type) => !isEpicArtifactKind(type));
