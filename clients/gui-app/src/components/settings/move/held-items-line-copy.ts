/**
 * Secrets page held-items line. Self-retiring: the parent omits it when no
 * held row is left. `Review them` is the verb that opens the retrospective
 * sheet.
 */
export function heldItemsLineText(count: number, hostName: string): string {
  const items = count === 1 ? "1 item" : `${count} items`;
  const verb = count === 1 ? "is" : "are";
  return `${items} from ${hostName} ${verb} not in use · Review them`;
}

export const HELD_ITEMS_REVIEW_LABEL = "Review them";
