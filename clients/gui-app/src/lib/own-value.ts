/**
 * `record[key]` when `key` is one of the record's own: a key from outside
 * (`constructor`, `__proto__`) never reads what every object inherits.
 */
export function ownValue<T>(
  record: Readonly<Partial<Record<string, T>>>,
  key: string,
): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
