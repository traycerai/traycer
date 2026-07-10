import babel from "@rolldown/plugin-babel";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig, type HtmlTagDescriptor, type UserConfig } from "vite";
import { CONTENT_SECURITY_POLICY } from "./src/shared/content-security-policy";

const rendererEnvPrefix = [
  "VITE_APP_",
  "VITE_DESKTOP_",
  "VITE_DEV_DESKTOP_SLOT",
  "VITE_POSTHOG_KEY",
  "VITE_TRAYCER_OSS_REPO",
  "VITE_TRAYCER_SIGN_IN_URL",
  "VITE_VIRTUOSO_MESSAGE_LIST_LICENSE_KEY",
];

/**
 * Desktop renderer Vite config.
 *
 * Builds `src/renderer-shell/index.html` + `src/renderer-shell/main.tsx` into
 * `dist/renderer/`. The renderer consumes `@traycer-clients/gui-app` as a
 * workspace library - there is no separate `gui-app` build step - so this
 * config mirrors the plugin chain that `gui-app` itself previously required
 * (TanStack Router codegen, React + compiler preset, Tailwind v4). Aliases
 * route `@/…` into `gui-app/src` so `gui-app`'s internal imports resolve in
 * the desktop build.
 */
export default defineConfig((): UserConfig => {
  const noWatch = process.env.TRAYCER_DESKTOP_NO_WATCH === "1";
  const port = Number(process.env.PORT) || 5173;
  const guiAppRoot = resolve(__dirname, "..", "gui-app");
  const sharedRoot = resolve(__dirname, "..", "shared");
  const protocolRoot = resolve(__dirname, "..", "..", "protocol");

  return {
    root: resolve(__dirname, "src", "renderer-shell"),
    base: "./",
    publicDir: false,
    envPrefix: rendererEnvPrefix,
    plugins: [
      // Inject the CSP <meta> from the single shared directive list
      // (src/shared/content-security-policy.ts) so it can never drift from the
      // response-header CSP in electron-main/app/security.ts.
      {
        name: "traycer-inject-csp-meta",
        transformIndexHtml(): HtmlTagDescriptor[] {
          return [
            {
              tag: "meta",
              attrs: {
                "http-equiv": "Content-Security-Policy",
                content: CONTENT_SECURITY_POLICY,
              },
              injectTo: "head-prepend",
            },
          ];
        },
      },
      tanstackRouter({
        target: "react",
        quoteStyle: "double",
        semicolons: true,
        autoCodeSplitting: true,
        routeFileIgnorePattern: "__tests__|route-components|route-search",
        routesDirectory: resolve(guiAppRoot, "src", "routes"),
        generatedRouteTree: resolve(guiAppRoot, "src", "routeTree.gen.ts"),
      }),
      react(),
      tailwindcss(),
      babel({ presets: [reactCompilerPreset()] }).then((plugin) => ({
        ...plugin,
        enforce: "post" as const,
      })),
      sentryVitePlugin({
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        disable: !process.env.SENTRY_AUTH_TOKEN || !process.env.SENTRY_ORG,
      }),
    ],
    resolve: {
      alias: {
        "@": resolve(guiAppRoot, "src"),
        "@traycer-clients/gui-app": resolve(guiAppRoot, "index.ts"),
        "@traycer-clients/shared": sharedRoot,
        // Cross-workspace imports that gui-app makes at runtime - the
        // tsconfig `paths` entries cover type-checking, but vite needs
        // explicit aliases so dependency pre-bundling can resolve them.
        // The `utils` entry must precede the bare `@traycer/protocol`
        // entry so vite matches the longer prefix first.
        "@traycer/protocol/utils": resolve(protocolRoot, "utils"),
        "@traycer/protocol": resolve(protocolRoot, "src"),
      },
    },
    build: {
      emptyOutDir: true,
      outDir: resolve(__dirname, "dist", "renderer"),
      sourcemap: "hidden",
    },
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
      // `make dev-desktop ARGS=--no-watch` sets this so the renderer
      // freezes alongside the host watcher: no HMR socket and no file
      // watcher, so UI edits never reload the Electron window until a
      // manual restart. Default dev keeps live reload (`hmr: true`).
      hmr: noWatch ? false : true,
      watch: noWatch ? null : undefined,
    },
  };
});
