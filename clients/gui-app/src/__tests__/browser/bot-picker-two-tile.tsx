import { createRoot } from "react-dom/client";

import { useSideTabStripStore } from "@/stores/layout/side-tab-strip-store";
import { TwoTileFixture } from "./bot-picker-two-tile-page";

// The strip is collapsed (the rail) unless the page is asked for
// `?strip=expanded`, and the choice is made before the first render.
const expanded =
  new URLSearchParams(window.location.search).get("strip") === "expanded";
useSideTabStripStore.setState({ collapsed: !expanded });

const root = document.querySelector("#root");
if (root === null) throw new Error("bot picker two-tile root missing");
createRoot(root).render(<TwoTileFixture />);
