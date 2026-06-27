import type { ReactElement, SVGProps } from "react";
import CodexMono from "@lobehub/icons/es/Codex/components/Mono";
import ClaudeColor from "@lobehub/icons/es/Claude/components/Color";
import OpenCodeMono from "@lobehub/icons/es/OpenCode/components/Mono";
import CursorMono from "@lobehub/icons/es/Cursor/components/Mono";
import GrokMono from "@lobehub/icons/es/Grok/components/Mono";
import GithubCopilotMono from "@lobehub/icons/es/GithubCopilot/components/Mono";
import { Bot } from "lucide-react";
import KimiMono from "@lobehub/icons/es/Kimi/components/Mono";

export type HarnessIcon = (props: SVGProps<SVGSVGElement>) => ReactElement;

// Brand logos come from @lobehub/icons (every provider lives there, so we don't
// hand-roll SVGs). We import the leaf component files rather than each provider's
// barrel: the barrel also pulls the `Combine`/`Avatar` variants, which depend on
// `@lobehub/ui` + antd - peers we don't install - and would break Vite's dep
// prebundle. The mono variants paint with `currentColor`, so they follow the
// light/dark theme via the `text-*` class applied by `HarnessIcon`; Claude uses
// the colored sunburst so it keeps its brand orange in both themes.
export const CodexIcon: HarnessIcon = (props) => <CodexMono {...props} />;
export const ClaudeAIIcon: HarnessIcon = (props) => <ClaudeColor {...props} />;
export const OpenCodeIcon: HarnessIcon = (props) => <OpenCodeMono {...props} />;
export const CursorIcon: HarnessIcon = (props) => <CursorMono {...props} />;
export const GrokIcon: HarnessIcon = (props) => <GrokMono {...props} />;
export const CopilotIcon: HarnessIcon = (props) => (
  <GithubCopilotMono {...props} />
);
export const DroidIcon: HarnessIcon = (props) => <Bot {...props} />;
export const KimiIcon: HarnessIcon = (props) => <KimiMono {...props} />;

// Traycer does not have a lobehub entry — hand-rolled from the brand mark.
export const TraycerIcon: HarnessIcon = (props) => (
  <svg {...props} viewBox="0 0 211 218" fill="currentColor">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="m42.181 178.442 2.409 2.427.233.24c7.46 7.952 7.39 20.732-.233 28.564-7.623 7.832-20.062 7.904-27.802.24l-.233-.24-2.409-2.45-6.523-6.727c-7.693-7.904-7.693-20.853 0-28.804 7.692-7.904 20.342-7.904 28.035 0l6.523 6.75ZM174.384 67.021l2.338-2.379 27.1-27.843c7.693-7.928 7.693-20.877 0-28.804-7.74-7.928-20.343-7.928-28.035 0l-29.415 30.221-14.029 14.39c-7.693 7.928-7.693 20.877 0 28.805l14.029 14.39 2.502 2.546 27.1 27.844c7.692 7.928 20.295 7.928 28.035 0 7.693-7.904 7.693-20.877 0-28.78l-27.1-27.844-2.525-2.546ZM8.744 8.187v-.024c7.694-7.928 20.32-7.928 28.036 0l166.855 171.456c7.716 7.904 7.716 20.877 0 28.781a19.496 19.496 0 0 1-28.035 0L8.745 36.943c-7.693-7.904-7.693-20.852 0-28.756Zm-.233 82.065c7.693-7.904 20.296-7.904 28.035 0l18.986 19.531 68.206 70.077c7.716 7.903 7.716 20.876 0 28.804a19.537 19.537 0 0 1-28.035 0l-27.077-27.843-60.115-61.765c-7.716-7.904-7.716-20.9 0-28.804Z"
    />
  </svg>
);
