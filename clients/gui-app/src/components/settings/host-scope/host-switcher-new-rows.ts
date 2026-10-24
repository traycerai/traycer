/** One New sandbox row: a configuration a new sandbox can be staged in. */
export interface HostSwitcherNewRow {
  /** `personal` or the team id. */
  readonly configurationKey: string;
  /** `New Acme sandbox`, or `New Acme sandbox · needs credits`. */
  readonly label: string;
  /** Shape · price · whose credits. */
  readonly subLine: string;
  /** The configuration's name, for the collapsed group and the search. */
  readonly configurationName: string;
  /** Nothing can be created: the sub-line says why, and a pick stages nothing. */
  readonly disabled: boolean;
}

/**
 * At one or two configurations every New row shows; past two, the remembered
 * configuration (else the first) leads and the rest collapse.
 */
export function splitNewRows(
  rows: readonly HostSwitcherNewRow[],
  rememberedConfigurationKey: string | null,
): {
  readonly head: readonly HostSwitcherNewRow[];
  readonly rest: readonly HostSwitcherNewRow[];
} {
  if (rows.length <= 2) return { head: rows, rest: [] };
  const lead =
    rows.find((row) => row.configurationKey === rememberedConfigurationKey) ??
    rows[0];
  return { head: [lead], rest: rows.filter((row) => row !== lead) };
}
