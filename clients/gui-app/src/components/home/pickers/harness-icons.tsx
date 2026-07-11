import type { ReactElement, SVGProps } from "react";
import CodexMono from "@lobehub/icons/es/Codex/components/Mono";
import ClaudeColor from "@lobehub/icons/es/Claude/components/Color";
import OpenCodeMono from "@lobehub/icons/es/OpenCode/components/Mono";
import CursorMono from "@lobehub/icons/es/Cursor/components/Mono";
import GrokMono from "@lobehub/icons/es/Grok/components/Mono";
import QwenMono from "@lobehub/icons/es/Qwen/components/Mono";
import KiroMono from "@lobehub/icons/es/Kiro/components/Mono";
import KiloCodeMono from "@lobehub/icons/es/KiloCode/components/Mono";
import GithubCopilotMono from "@lobehub/icons/es/GithubCopilot/components/Mono";
import OpenRouterMono from "@lobehub/icons/es/OpenRouter/components/Mono";
import KimiMono from "@lobehub/icons/es/Kimi/components/Mono";
import DevinMono from "@lobehub/icons/es/Devin/components/Mono";

export type HarnessIcon = (props: SVGProps<SVGSVGElement>) => ReactElement;

// Brand logos come from @lobehub/icons (every provider lives there, so we don't
// hand-roll SVGs). Most imports use leaf component files to avoid pulling extra
// variants; this includes OpenRouter, whose package barrels pull generated
// feature exports that are not needed here. The mono variants and Factory Droid
// mark paint with `currentColor`, so they follow the light/dark theme via the
// `text-*` class applied by `HarnessIcon`; Claude uses the colored sunburst so
// it keeps its brand orange in both themes.
export const CodexIcon: HarnessIcon = (props) => <CodexMono {...props} />;
export const ClaudeAIIcon: HarnessIcon = (props) => <ClaudeColor {...props} />;
export const OpenCodeIcon: HarnessIcon = (props) => <OpenCodeMono {...props} />;
export const CursorIcon: HarnessIcon = (props) => <CursorMono {...props} />;
export const GrokIcon: HarnessIcon = (props) => <GrokMono {...props} />;
export const QwenIcon: HarnessIcon = (props) => <QwenMono {...props} />;
export const KiroIcon: HarnessIcon = (props) => <KiroMono {...props} />;
export const KiloCodeIcon: HarnessIcon = (props) => <KiloCodeMono {...props} />;
export const CopilotIcon: HarnessIcon = (props) => (
  <GithubCopilotMono {...props} />
);
export const DroidIcon: HarnessIcon = (props) => (
  <svg {...props} viewBox="0 0 43 42" fill="currentColor">
    <path d="M30.64 7.14C30.52 7.11 30.42 7.05 30.34 6.95C30.26 6.86 30.22 6.74 30.21 6.62C30.21 6.54 30.22 6.46 30.26 6.39C31.34 3.82 31.82 1.77 31.04 0.91C29 -1.37 20.81 3.17 18.19 4.7C18.12 4.74 18.05 4.77 17.97 4.78C17.89 4.79 17.8 4.78 17.73 4.75C17.65 4.73 17.58 4.69 17.52 4.63C17.46 4.58 17.41 4.51 17.38 4.44C16.28 1.88 15.12 0.1 13.95 0.02C10.85 -0.18 8.35 8.66 7.62 11.54C7.6 11.62 7.56 11.69 7.51 11.75C7.46 11.82 7.4 11.87 7.32 11.9C7.25 11.94 7.17 11.96 7.09 11.96C7.01 11.96 6.93 11.95 6.85 11.92C4.21 10.86 2.1 10.4 1.22 11.15C-1.12 13.14 3.54 21.11 5.12 23.65C5.18 23.75 5.21 23.88 5.19 23.99C5.18 24.11 5.13 24.23 5.04 24.31C4.99 24.37 4.92 24.42 4.85 24.45C2.22 25.52 0.39 26.64 0.3 27.78C0.09 30.79 9.18 33.23 12.15 33.94C12.23 33.96 12.3 33.99 12.36 34.04C12.43 34.09 12.48 34.16 12.51 34.23C12.55 34.3 12.57 34.37 12.58 34.45C12.58 34.53 12.56 34.61 12.53 34.69C11.45 37.25 10.97 39.3 11.74 40.16C13.79 42.44 21.98 37.91 24.6 36.38C24.7 36.31 24.82 36.29 24.95 36.3C25.07 36.31 25.18 36.36 25.27 36.44C25.33 36.5 25.38 36.56 25.41 36.64C26.51 39.2 27.66 40.98 28.84 41.05C31.94 41.26 34.44 32.42 35.17 29.54C35.19 29.46 35.23 29.39 35.28 29.32C35.33 29.26 35.39 29.21 35.47 29.17C35.54 29.14 35.62 29.12 35.7 29.12C35.78 29.11 35.86 29.13 35.94 29.16C38.58 30.21 40.69 30.68 41.57 29.93C43.91 27.94 39.25 19.97 37.67 17.42C37.61 17.32 37.58 17.2 37.6 17.08C37.61 16.96 37.66 16.85 37.74 16.76C37.8 16.71 37.87 16.66 37.94 16.63C40.57 15.56 42.4 14.44 42.48 13.3C42.7 10.28 33.61 7.85 30.64 7.14M27.08 4.25C27.68 5.29 24.61 12.21 22.32 17.06C22.28 17.14 22.22 17.21 22.14 17.25C22.06 17.3 21.97 17.32 21.88 17.31C21.79 17.31 21.7 17.27 21.63 17.22C21.56 17.16 21.51 17.08 21.48 17C20.56 13.85 19.5 10.14 18.38 7C18.33 6.88 18.33 6.74 18.38 6.62C18.43 6.5 18.52 6.4 18.64 6.34C21.46 4.84 26.28 2.85 27.08 4.25ZM13.57 5.1C14.75 5.43 17.61 12.44 19.52 17.44C19.55 17.52 19.56 17.61 19.53 17.7C19.51 17.79 19.46 17.87 19.39 17.92C19.32 17.98 19.24 18.02 19.14 18.03C19.05 18.04 18.96 18.02 18.88 17.97C15.94 16.38 12.5 14.49 9.42 13.04C9.3 12.99 9.2 12.89 9.15 12.77C9.1 12.65 9.09 12.52 9.12 12.39C10.03 9.4 11.99 4.67 13.57 5.1ZM4.65 15C5.71 14.42 12.84 17.41 17.82 19.63C17.9 19.67 17.97 19.73 18.02 19.81C18.06 19.89 18.08 19.97 18.08 20.06C18.07 20.15 18.04 20.24 17.98 20.31C17.92 20.38 17.84 20.43 17.75 20.45C14.52 21.35 10.71 22.37 7.48 23.47C7.35 23.52 7.21 23.51 7.09 23.47C6.96 23.42 6.86 23.33 6.8 23.22C5.26 20.47 3.21 15.78 4.65 15ZM5.53 28.14C5.86 27 13.07 24.21 18.21 22.36C18.29 22.33 18.39 22.32 18.48 22.35C18.56 22.37 18.64 22.42 18.7 22.48C18.76 22.55 18.8 22.63 18.81 22.72C18.82 22.81 18.8 22.9 18.76 22.98C17.12 25.84 15.17 29.19 13.69 32.18C13.63 32.3 13.53 32.4 13.41 32.45C13.28 32.5 13.15 32.51 13.02 32.47C9.94 31.6 5.08 29.68 5.53 28.14ZM15.7 36.83C15.11 35.79 18.18 28.86 20.47 24.02C20.5 23.93 20.57 23.87 20.65 23.82C20.72 23.78 20.82 23.76 20.91 23.76C21 23.77 21.08 23.8 21.16 23.86C21.23 23.92 21.28 23.99 21.3 24.08C22.23 27.23 23.28 30.93 24.41 34.07C24.45 34.2 24.45 34.33 24.4 34.45C24.35 34.58 24.26 34.68 24.15 34.74C21.33 36.23 16.5 38.22 15.71 36.83H15.7ZM29.21 35.97C28.03 35.65 25.17 28.63 23.27 23.64C23.23 23.55 23.23 23.46 23.25 23.37C23.28 23.29 23.32 23.21 23.39 23.15C23.46 23.09 23.55 23.06 23.64 23.05C23.73 23.04 23.82 23.06 23.9 23.1C26.85 24.69 30.28 26.59 33.37 28.03C33.49 28.09 33.58 28.19 33.64 28.31C33.69 28.43 33.7 28.56 33.66 28.69C32.76 31.69 30.79 36.41 29.21 35.97ZM38.14 26.07C37.07 26.65 29.95 23.66 24.97 21.44C24.89 21.4 24.82 21.34 24.77 21.27C24.72 21.19 24.7 21.1 24.71 21.01C24.72 20.92 24.75 20.84 24.81 20.77C24.87 20.7 24.95 20.65 25.03 20.62C28.27 19.73 32.08 18.7 35.31 17.6C35.43 17.56 35.57 17.56 35.7 17.61C35.82 17.66 35.93 17.74 35.99 17.86C37.53 20.6 39.58 25.29 38.14 26.07ZM37.26 12.93C36.93 14.08 29.72 16.86 24.58 18.72C24.49 18.75 24.4 18.75 24.31 18.73C24.22 18.71 24.14 18.66 24.08 18.59C24.02 18.52 23.99 18.44 23.98 18.35C23.97 18.26 23.99 18.17 24.03 18.09C25.67 15.23 27.61 11.89 29.1 8.89C29.16 8.77 29.26 8.68 29.38 8.63C29.5 8.57 29.64 8.57 29.77 8.6C32.85 9.48 37.71 11.39 37.26 12.93Z" />
  </svg>
);
export const OpenRouterIcon: HarnessIcon = (props) => (
  <OpenRouterMono {...props} />
);
export const KimiIcon: HarnessIcon = (props) => <KimiMono {...props} />;

// Amp (Ampcode / Sourcegraph) has no lobehub entry — the official brand mark
// (three ascending bars) from coder/registry's `sourcegraph-amp.svg`. Painted in
// Amp's brand red so it keeps its identity in both light and dark themes, like
// the Claude colored sunburst.
export const AmpIcon: HarnessIcon = (props) => (
  <svg {...props} viewBox="0 0 19 19" fill="none">
    <path
      fill="#F34E3F"
      d="M3.41508 17.2983L7.88484 12.7653L9.51146 18.9412L11.8745 18.2949L9.52018 9.32758L0.69527 6.93747L0.066864 9.35199L6.13926 11.0015L1.68806 15.5279L3.41508 17.2983Z"
    />
    <path
      fill="#F34E3F"
      d="M16.3044 12.0436L18.6675 11.3973L16.3132 2.43003L7.48824 0.0399246L6.85984 2.45444L14.312 4.47881L16.3044 12.0436Z"
    />
    <path
      fill="#F34E3F"
      d="M12.9126 15.4902L15.2756 14.8439L12.9213 5.87659L4.09639 3.48648L3.46799 5.901L10.9201 7.92537L12.9126 15.4902Z"
    />
  </svg>
);

// Devin (Cognition) — lobehub monochrome brand mark (`currentColor` theming).
export const DevinIcon: HarnessIcon = (props) => <DevinMono {...props} />;

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
