/**
 * Dates a person reads for an earlier release's action, matching the boards
 * (`14 Oct`, `20 Oct`). Day then short month, no year: the evidence is recent
 * enough that the year is the current one, and a missing stamp reads
 * `unknown` at the call site rather than here.
 */
export function formatEvidenceDate(at: number): string {
  const date = new Date(at);
  const month = date.toLocaleDateString("en-GB", { month: "short" });
  return `${date.getDate()} ${month}`;
}
