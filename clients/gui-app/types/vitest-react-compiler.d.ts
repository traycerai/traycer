declare module "@rolldown/plugin-babel" {
  import type { PluginOption } from "vite";

  export default function babel(options: {
    readonly presets: ReadonlyArray<unknown>;
  }): Promise<PluginOption>;
}

declare module "@vitejs/plugin-react" {
  export function reactCompilerPreset(): unknown;
}
