import { readFileSync } from "node:fs";
import path from "node:path";
import { mergeConfig } from "vitest/config";
import base from "../vitest.config";

const sourceOverrides: ReadonlyArray<{ env: string; file: string }> = [
  {
    env: "ANCHOR_GATE_TOOLTIP_SOURCE",
    file: path.resolve(
      __dirname,
      "..",
      "src/components/ui/tooltip-wrapper.tsx",
    ),
  },
  {
    env: "ANCHOR_GATE_TOOLTIP_PRIMITIVE_SOURCE",
    file: path.resolve(__dirname, "..", "src/components/ui/tooltip.tsx"),
  },
  {
    env: "ANCHOR_GATE_USER_MENU_SOURCE",
    file: path.resolve(__dirname, "..", "src/components/auth/user-menu.tsx"),
  },
  {
    env: "ANCHOR_GATE_PERMISSIONS_SOURCE",
    file: path.resolve(
      __dirname,
      "..",
      "src/components/home/pickers/permissions-picker.tsx",
    ),
  },
  {
    env: "ANCHOR_GATE_RATE_LIMIT_SOURCE",
    file: path.resolve(
      __dirname,
      "..",
      "src/components/layout/header/rate-limit-icon.tsx",
    ),
  },
  {
    env: "ANCHOR_GATE_WORKSPACE_SOURCE",
    file: path.resolve(
      __dirname,
      "..",
      "src/components/home/host-workspace-selector/workspace-folder-summary-control.tsx",
    ),
  },
];

// Run a saved pre-fix control without changing the production source file.
const sourceOverridePlugin = {
  name: "anchor-gate-source-override",
  load(id: string): string | null {
    for (const { env, file } of sourceOverrides) {
      const envPath = process.env[env];
      if (envPath !== undefined && id === file)
        return readFileSync(envPath, "utf8");
    }
    return null;
  },
};

export default mergeConfig(base, {
  plugins: [sourceOverridePlugin],
  resolve: {
    alias: [
      {
        find: "@/components/layout/tabs/tab-strip",
        replacement: path.resolve(
          __dirname,
          "..",
          "src/__tests__/browser/stubs/tab-strip-stub.tsx",
        ),
      },
    ],
  },
});
