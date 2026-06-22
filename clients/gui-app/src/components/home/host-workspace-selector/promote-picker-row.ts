export function promotePickerRow<T extends { readonly id: string }>(
  rows: ReadonlyArray<T>,
  rowId: string | null,
): ReadonlyArray<T> {
  if (rowId === null || rows.length < 2) return rows;
  const index = rows.findIndex((row) => row.id === rowId);
  if (index <= 0) return rows;
  const selected = rows[index];
  return [selected, ...rows.slice(0, index), ...rows.slice(index + 1)];
}
