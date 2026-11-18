import type { PluggableList } from "unified";
import { rehypeCustomMermaid } from "./rehype-custom-mermaid";
import { rehypeCustomWireframe } from "./rehype-custom-wireframe";
import { rehypeTraycerChat } from "./rehype-traycer-chat";
import { rehypeTraycerEpic } from "./rehype-traycer-epic";
import { rehypeTraycerSpec } from "./rehype-traycer-spec";
import { rehypeTraycerTicket } from "./rehype-traycer-ticket";

// Product rehype plugins only. Tailmark already runs rehype-raw, sanitize, and
// its marker policy; do not re-register GFM / disable-indented-code (built-in).
// Intentionally no Tailmark `repairs` for next-steps - custom repairs force the
// full-document repair path, and TextSegment peels next-steps before render.
export const PRODUCT_REHYPE_PLUGINS: PluggableList = [
  rehypeCustomMermaid,
  rehypeCustomWireframe,
  rehypeTraycerChat,
  rehypeTraycerEpic,
  rehypeTraycerSpec,
  rehypeTraycerTicket,
];
