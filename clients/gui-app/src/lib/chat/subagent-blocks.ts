import type { SubAgentBlock } from "@traycer/protocol/persistence/epic/schemas";

export function isRenderableSubAgentBlock(block: SubAgentBlock): boolean {
  // Render a sub-agent only once it has a task or some progress. A real
  // sub-agent always has a task (the Codex converter falls back to a generic
  // label when the spawn prompt is empty, so an empty-prompt child still
  // renders); a degenerate name-only block - e.g. a background command surfaced
  // as a pseudo-subagent - is intentionally dropped.
  return (
    (block.task !== null && block.task.trim().length > 0) ||
    block.progressUpdates.length > 0
  );
}
