import type { ReactNode } from "react";
import type { EpicNodeKind } from "@/lib/artifacts/node-display";

/**
 * Row-2 (workspace line) slot for a chat / terminal-agent sidebar row.
 *
 * **T1 is scaffold-only: this renders `null`.** It is the reserved, isolated
 * seam that T2 fills, so the two-line row layout ships now while the data that
 * populates the second line lands later without touching the row scaffold.
 *
 * Why a self-collapsing child (returns `null`) rather than a value the row
 * inspects: the flex-column row body simply lists row 1 then this component. A
 * React `null` renders no DOM node, so the column has a single child and the
 * row stays one line - "no row-2 content → single-row collapse" falls out for
 * free, and the scaffold needs zero knowledge of the row-2 data shape.
 *
 * Why no data in T1 (deliberate, per the T1/T2 boundary): the sidebar reads the
 * epic-store `ChatProjection`, which carries no `worktreeBinding` - a chat's
 * binding lives only in its per-open-chat session snapshot, and branch /
 * `ownedSubmodules` / PR facts come from the host `worktree.listAllForHost`
 * batch. That batch is T2. T2 will populate this slot uniformly for BOTH chat
 * and terminal-agent rows (owners carry `ownerKind`) with: the primary entry's
 * branch (or folder name via `workspaceFolderName()` for a non-git / local
 * entry), a `+N` badge counting extra entries + owned submodules, and the PR
 * icons. `epicId` / `nodeId` / `artifactType` are threaded now so T2 fills in
 * only this component body, not every call site.
 *
 * T2 note: this slot mounts in THREE row variants - the display `<button>`, the
 * selection-mode `<label>`, and the rename row - so it must render **phrasing
 * content** (a `<span>`-rooted `inline-flex` line, not a `<div>`) to stay valid
 * HTML in the strictest of them (`<button>` accepts phrasing content only; the
 * `<label>` wraps the checkbox, so a nested interactive element there would also
 * hijack its activation). PR-icon click handlers will need `stopPropagation()`
 * so opening a PR doesn't also trigger the row's select/open.
 */
export interface ChatRowSecondLineProps {
  readonly epicId: string;
  readonly nodeId: string;
  readonly artifactType: EpicNodeKind;
}

export function ChatRowSecondLine(_props: ChatRowSecondLineProps): ReactNode {
  // T1 renders nothing, so the row collapses to a single line. The props are
  // the reserved T2 seam - see the file docs for what T2 renders here.
  return null;
}
