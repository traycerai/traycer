import { createRoot } from "react-dom/client";
import { SandboxLinkConfirm } from "@/components/sandbox/sandbox-link-confirm";
import { MAX_LINK_URL_CHARS } from "@/lib/sandbox/bridge-host";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * The link confirm a sandboxed page's `ui/open-link` raises, holding the
 * longest URL the bridge lets through. The claim is layout, which jsdom cannot
 * decide: the dialog stays inside the viewport, the URL scrolls, and both
 * actions stay in view.
 */
const BASE = "https://example.com/";
const LONGEST_URL = BASE + "a".repeat(MAX_LINK_URL_CHARS - BASE.length);

const container = document.getElementById("root");
if (container !== null) {
  createRoot(container).render(
    <SandboxLinkConfirm
      url={LONGEST_URL}
      kind="page"
      onDecide={() => undefined}
    />,
  );
}
