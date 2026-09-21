import { createLucideIcon } from "lucide-react";

/** A globe with an inset exclamation, shared by browser tabs and the feed. */
export const GlobeAlert = createLucideIcon("globe-alert", [
  ["circle", { cx: "12", cy: "12", r: "10", key: "outline" }],
  [
    "path",
    {
      d: "M2 12h5m10 0h5M12 2C5 7 5 17 12 22M12 2c7 5 7 15 0 20",
      key: "grid",
    },
  ],
  ["path", { d: "M12 8v5m0 3h.01", key: "alert" }],
]);
