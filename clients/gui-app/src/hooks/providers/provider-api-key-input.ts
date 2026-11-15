/** Dispatch consumes the form's snapshot without retaining it in mutation variables. */
export function takeProviderApiKeyInput(input: {
  current: string | null;
}): string {
  const value = input.current;
  input.current = null;
  if (value === null || value.length === 0) {
    throw new Error("Provider key input is unavailable");
  }
  return value;
}
