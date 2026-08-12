export interface ModelBlockRef {
  readonly harnessId: string;
  readonly model: string | null;
}

/**
 * Same matching the pack ladder uses when skipping blocked providers/models.
 * Keep this the single source of truth for CLI skip + GUI badges.
 */
export function findModelBlock<T extends ModelBlockRef>(
  entry: { readonly harnessId: string; readonly model: string },
  blocks: readonly T[],
): T | null {
  const harness = entry.harnessId.toLowerCase();
  const model = entry.model.toLowerCase();
  for (const block of blocks) {
    if (block.harnessId.toLowerCase() !== harness) continue;
    if (block.model === null || block.model === "") return block;
    if (block.model.toLowerCase() === model) return block;
    const token = block.model.toLowerCase();
    if (
      model === token ||
      model.startsWith(`${token}/`) ||
      model.endsWith(`/${token}`) ||
      model.includes(`/${token}/`) ||
      model.includes(`${token}-`) ||
      model.startsWith(`${token}-`)
    ) {
      return block;
    }
  }
  return null;
}

export function isModelBlocked(
  entry: { readonly harnessId: string; readonly model: string },
  blocks: readonly ModelBlockRef[],
): boolean {
  return findModelBlock(entry, blocks) !== null;
}
