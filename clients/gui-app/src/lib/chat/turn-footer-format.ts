/**
 * The agent chat's turn footer, as words and figures: the verb that says how
 * long a turn worked, and its cost, as the footer
 * (`chat-message-assistant-body.tsx`) says them.
 */

/**
 * Compact USD formatter for the cost row: sub-dollar turns show 4 decimals
 * ("$0.0123"); a positive amount too small to show at 4 decimals reads
 * "<$0.0001" rather than a misleading "$0.0000"; >= $1 shows 2 decimals.
 */
export function formatUsd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value < 0.0001) return "<$0.0001";
  // A sub-dollar value that rounds up to 1 at 4 decimals (e.g. 0.99999 ->
  // "1.0000") should read "$1.00", not the misleading "$1.0000".
  const rounded = value.toFixed(4);
  return Number(rounded) >= 1 ? `$${value.toFixed(2)}` : `$${rounded}`;
}

/**
 * Past-tense verbs rotated per turn so the footer reads playfully rather than
 * mechanically (Claude Code CLI pattern). Seeded by `messageId` (stable per
 * turn AND distinct between sibling turns sharing one user-send) so the verb
 * never flips on re-render and never collides on adjacent rows.
 */
const ELAPSED_VERBS = [
  "Cogitated",
  "Pondered",
  "Crunched",
  "Brewed",
  "Noodled",
  "Mulled",
  "Schemed",
  "Hatched",
  "Tinkered",
  "Conjured",
  "Distilled",
  "Wrangled",
  "Marinated",
  "Riffed",
  "Sleuthed",
  "Plotted",
  "Stewed",
  "Forged",
  "Spelunked",
  "Channeled",
] as const;

export function pickElapsedVerb(seed: string): string {
  // djb2 - fast, well-distributed for short strings, no allocation.
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) + hash + seed.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % ELAPSED_VERBS.length;
  return ELAPSED_VERBS[index] ?? ELAPSED_VERBS[0];
}
