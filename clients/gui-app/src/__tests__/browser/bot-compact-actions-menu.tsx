import { createRoot } from "react-dom/client";

import { CompactActionsFixture } from "./bot-compact-actions-menu-view";

const root = document.querySelector("#root");
if (root === null) throw new Error("bot compact actions menu root missing");
createRoot(root).render(<CompactActionsFixture />);
