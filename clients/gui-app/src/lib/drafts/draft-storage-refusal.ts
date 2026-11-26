export type DraftStoragePress =
  | "staged-send"
  | "restored-send"
  | "restored-open"
  | "restored-wake"
  | "restored-start"
  | "pending-return"
  | "live-send";

export type DraftStorageRefusalPresentation =
  | {
      readonly kind: "composer-failure";
      readonly title: string;
      readonly description: string;
    }
  | { readonly kind: "pending-return-failure" }
  | { readonly kind: "none" };

/** Maps a storage refusal from an explicit press to the caller's existing surface. */
export function draftStorageRefusalPresentation(
  press: DraftStoragePress,
): DraftStorageRefusalPresentation {
  switch (press) {
    case "pending-return":
      return { kind: "pending-return-failure" };
    case "live-send":
      return { kind: "none" };
    case "staged-send":
    case "restored-send":
    case "restored-open":
    case "restored-wake":
    case "restored-start":
      return {
        kind: "composer-failure",
        title: "Couldn't save your draft.",
        description: "Copy your message before closing this window.",
      };
  }
}
