import { createLucideIcon } from "lucide-react";

/**
 * Lucide-style message-square glyph with a clock badge. The bubble follows the
 * app's canonical chat icon and opens at the lower-right so the clock remains
 * legible at the compact indicator size.
 */
export const MessageSquareClock = createLucideIcon("message-square-clock", [
  [
    "path",
    {
      d: "M22 8.5V5a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v16.286a.71.71 0 0 0 1.212.502l2.202-2.202A2 2 0 0 1 6.828 19H8.5",
      key: "1yt8rh",
    },
  ],
  ["path", { d: "M16 14v2.2l1.6 1", key: "fo4ql5" }],
  ["circle", { cx: "16", cy: "16", r: "6", key: "qoo3c4" }],
]);
