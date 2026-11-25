export type DraftStoragePress =
  | "staged-send"
  | "restored-send"
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
      return {
        kind: "composer-failure",
        title: "Couldn't save your draft.",
        description: "Copy your message before closing this window.",
      };
  }
}
