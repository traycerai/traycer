import { v4 as uuidv4 } from "uuid";

export function mintDraftId(): string {
  return uuidv4();
}

export function interviewDraftBindingKey(
  chatId: string,
  blockId: string,
): string {
  return `${chatId}\u0000${blockId}`;
}
