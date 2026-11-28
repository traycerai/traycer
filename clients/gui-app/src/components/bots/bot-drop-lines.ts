/**
 * What a Tracy pane says about a file dropped or attached on it. The
 * wording of each line is Tanveer's; tests assert these constants, not
 * copies of them.
 */

/** A box, or a box still reading its draft, whose host takes no images. */
export const DROP_WITHOUT_IMAGE_HOST =
  "This host doesn't take images in Tracy's messages. Update it to add them.";

/** A Threads card whose post is gone from the channel: it never gets a box. */
export const DROP_AFTER_POST_GONE =
  "This thread's post is gone from the channel, so files can't be added here.";

/** Under a box still reading its draft's images, while images held for it wait. */
export const DROPS_WAIT_FOR_DRAFT_IMAGES =
  "Images you drop or attach now are added once the draft's images load.";
