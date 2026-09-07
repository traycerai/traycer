/** The narrow-width half of a settings row's geometry, shared by every row that pairs a label block with a
 * control. */
export const SETTINGS_ROW_STACK = {
  /** Row container: the wrapping the floor acts through, plus room between the two lines once a control has taken
   * one of its own. */
  container: "flex-wrap max-md:gap-y-3",
  /** Label block: the width floor that sends a wide control to the next line instead of letting it take the
   * label's. */
  label: "max-md:min-w-[70%]",
  /** Control: holds its intrinsic width rather than shrink into the label's. */
  control: "max-md:shrink-0",
} as const;
