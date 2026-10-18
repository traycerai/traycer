const COUNT_FORMAT = new Intl.NumberFormat();

/** A count as the reader's locale groups it: `1,284`, not `1284`. */
export function formatCount(count: number): string {
  return COUNT_FORMAT.format(count);
}
