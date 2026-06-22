export const DEFAULT_TERMINAL_TITLE = "New Terminal";

export function terminalSessionTitle(input: {
  readonly title: string | null;
}): string {
  if (input.title !== null && input.title.length > 0) return input.title;
  return DEFAULT_TERMINAL_TITLE;
}
