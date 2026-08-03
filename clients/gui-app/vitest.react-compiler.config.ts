import babel from "@rolldown/plugin-babel";
import { reactCompilerPreset } from "@vitejs/plugin-react";
import { mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config";

export default mergeConfig(baseConfig, {
  plugins: [
    babel({ presets: [reactCompilerPreset()] }).then((plugin) => ({
      ...plugin,
      enforce: "post" as const,
    })),
  ],
});
