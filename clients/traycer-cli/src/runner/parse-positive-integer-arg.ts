// Strict positive-integer CLI arg parser: reject anything that is not a
// clean decimal run before parsing, so Number.parseInt's prefix tolerance
// ("42junk" -> 42, "42.9" -> 42) cannot admit a plausible wrong value.
export function parsePositiveIntegerArg(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
