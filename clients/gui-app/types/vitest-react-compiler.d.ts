declare module "@rolldown/plugin-babel" {
  import type { Plugin } from "vite";

  export default function babel(options: {
    readonly presets: ReadonlyArray<unknown>;
  }): Promise<Plugin>;
}

declare module "@vitejs/plugin-react" {
  export function reactCompilerPreset(): unknown;
}
