/** The id of the composer menu's row at `index`, in the listbox `listboxId`. */
export function composerMenuOptionId(listboxId: string, index: number): string {
  return `${listboxId}-item-${index}`;
}
