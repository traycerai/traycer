import path from "path";
import os from "node:os";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { transformWithOxc } from "vite";
import { defineConfig } from "vitest/config";

const availableParallelism =
  typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
const MAX_TEST_WORKERS = Math.min(
  2,
  Math.max(1, Math.floor(availableParallelism / 2)),
);
// `use-workspace-file-list-subscription` is here for the same reason: its
// pending flag used to be a render-time read of a module-level registry, which
// the compiler cached at "no entry yet" forever (the file tree's permanent
// spinner). Only the compiled hook can regress that way, so only the compiled
// hook can prove the fix. The `pr.*` shared-subscription trio had the same
// shape (`registry.get(key)` and `entry.lastEvent` read at render).
// `auth-brand-splash` / `auth-landing-page` join them after the same failure in
// its sharpest form: the launch splash derived its phase from a boolean, the
// compiler memoized that derivation on inputs the animation timer did not
// touch, and the cached value outlived the timer - a sign-in screen that never
// went away, on a real device. The suite was green throughout, because it ran
// the UNCOMPILED hook while production mobile compiles everything. A test that
// does not run the compiled component cannot see this class of bug at all.
// `relative-time` / `routing-card` are the desktop repeat of the exact same
// shape, caught live rather than in review: the routing card's countdown (then
// `fallback-grace-card`) froze at "in 3m 27s" for a 15s window and never moved
// until the host switched. The routing card's drain bar reads the same
// snapshot (`useGraceCountdownState`), so a frozen bar is the same regression
// with a width instead of a string. `useGraceCountdown` used to discard
// `useSyncExternalStore`'s return and read the mutable
// `secondClock.sampledNow()` at render time; the compiler memoized
// `formatGraceCountdown(deadline, secondClock.sampledNow())` on `deadline`
// alone, so every tick re-rendered the leaf and got back the FIRST render's
// string. It now renders from the store's return value instead. The
// minute-clock hooks in the same file
// (`useCompactRelativeTime`, `useRelativeTimestamp`, `useSampledNow`,
// `useResetCountdown`, `useIsFarReset`, `useMessageTime`) share the shape and
// were invisible for the same reason: the suite ran them uncompiled while the
// desktop renderer compiles the whole tree, its dev server included (where
// the freeze was seen).
// `simulator-tile` keeps per-instance memory in render-time state writes
// (whether its own `simulator.open` was answered, whether it has been live)
// and reads a mutation's per-call callbacks; both are shapes the compiler
// rewrites, so its suite runs compiled too.
// `use-environment-members-query` read the query cache at render time to
// walk its page chain; the compiler memoized that walk on the environment and
// host alone, so a page that answered re-rendered the hook and got back the
// first render's cursors - a team's second page was never asked for.
// The rest are one class, swept together: a render read of something that
// changes inside an object whose identity does not - a module registry entry,
// a query cache, a host client, a requester, a kept-alive engine - which the
// compiled renderer memoizes on that identity and answers from forever after.
// Each file's suite has a case that is red on the shape it used to have:
// - `use-git-list-changed-files-subscription`: a git error or a closed stream
//   never left pending (the shared entry's last frame).
// - `use-host-stream-client-for`: a sign-in after mount never built the
//   host's stream client (the context `setRequestContext` swaps inside the one
//   spine client); `use-host-client-for` reads it through the same subscribed
//   hook and builds its client on the sign-in itself;
//   `epic-tab-existence-reconciler`: a lease bound after mount never probed
//   the hosts for local copies.
// - `use-providers-login-ownership`: a host whose directory row landed after
//   mount never got login ownership (a requester pinned by id answers `null`
//   until its row lands).
// - `worktrees-enrichment`, `use-worktree-task-titles`, `teardown-agent-names`,
//   `use-diff-highlight-ready`: a `void tick;` trigger the compiler drops, so
//   a row stayed on "Checking", a restored row stayed locked, a title or a
//   rename never showed, a theme switch never re-primed highlighting.
// - `composer.source`: the palette kept the model the composer had left.
// - `top-level-tab-host`: a tab locked mid-drag kept its drop ring.
// - `use-comm-graph-jump` with `comm-graph-agent-detail-surface`: a row kept
//   its open-agent links after the host went offline.
// - `terminal-tile`, `landing-terminal-tile`, `use-terminal-tile-bootstrap`,
//   `use-host-terminal-bootstrap`: a reopened terminal opened at the grid its
//   engine had before the measure wait ended.
// - `chat-routing-menu`: a tab menu opened before its chat's session kept the
//   routing setting out for as long as it stayed up.
// - `tab-appearance-menu`: a tab whose own task lookup was pending never took
//   the strip's batch from the cache, so Labels and grouping stayed hidden.
// `workspace-file-tile`, `split-slot-chooser`, `resource-monitor-popover`,
// `sidebar-artwork` and `dock-modes` read the same kind of source and are
// correct as they stand; their cases hold that once they run compiled.
const REACT_COMPILER_REGRESSION_FILES =
  /[/\\](?:composer-prompt-editor|use-workspace-file-list-subscription|shared-stream-subscription|use-header-tabs|use-pr-(?:list|detail)-subscription|auth-brand-splash|auth-landing-page|use-auth-splash-cover|relative-time|routing-card|use-environment-members-query|use-git-list-changed-files-subscription|workspace-file-tile|worktrees-enrichment|use-worktree-task-titles|teardown-agent-names|resource-monitor-popover|use-comm-graph-jump|comm-graph-agent-detail-surface|top-level-tab-host|split-slot-chooser|landing-terminal-tile|use-terminal-tile-bootstrap|use-host-terminal-bootstrap|terminal-tile|use-diff-highlight-ready|composer\.source|sidebar-artwork|dock-modes|use-host-client-for|use-host-stream-client-for|use-providers-login-ownership|epic-tab-existence-reconciler|chat-routing-menu|tab-appearance-menu|react-compiler-harness-probe)\.(?:ts|tsx)$/;

// The compiler runs after the JSX transform, and the suite's transform is the
// development one: `jsxDEV(..., this)` passes `this`, the compiler bails on
// every function that returns JSX, and only hooks were ever compiled here - a
// component on the list above ran exactly as uncompiled code, green whether or
// not the bug shipped. The packaged renderer uses the production transform and
// compiles components too, so the listed files get that transform before
// anything else touches them; the rest of the suite keeps development JSX.
// `react-compiler-harness.test.tsx` fails if a listed component stops compiling.
const shippedJsxForCompilerRegressionFiles = {
  name: "traycer:shipped-jsx-for-compiler-regression-files",
  enforce: "pre" as const,
  async transform(code: string, id: string) {
    const file = id.split("?")[0];
    if (!file.endsWith(".tsx") || !REACT_COMPILER_REGRESSION_FILES.test(file)) {
      return null;
    }
    const result = await transformWithOxc(code, file, {
      jsx: { runtime: "automatic", development: false },
    });
    return { code: result.code, map: result.map };
  },
};

export default defineConfig({
  // Run the affected composer boundary through the packaged desktop
  // renderer's compiler preset. The regression that motivated it was
  // invisible when tests skipped this pass because the compiler may replace a
  // React imperative-handle facade during an ordinary editor render. The filter
  // keeps unrelated GUI tests on their existing fast transform path.
  plugins: [
    shippedJsxForCompilerRegressionFiles,
    react(),
    // This config is ALSO what the browser regressions serve their fixtures
    // from - every driver in `scripts/*-browser.mjs` spawns vite with
    // `--config vitest.config.ts`. Without this plugin, `@import "tailwindcss"`
    // at `src/index.css:1` compiles to NOTHING (there is no `postcss.config.*`
    // here, so there is no second compile path), and the fixtures render with
    // the utility classes present on every element and no rules behind them:
    // `h-8` measured 24px, `DialogFooter`'s `flex` computed `display: block`,
    // `bg-primary` computed `rgba(0, 0, 0, 0)`.
    //
    // That is a harness that lies in the SAFE direction. A fixture asserting
    // two nodes share a left edge passes trivially when both are unstyled
    // blocks at the same content edge, and one asserting a control is "filled"
    // passes-as-transparent - on the fixed tree and the broken one alike. Any
    // geometric or colour claim measured without this was vacuous.
    //
    // jsdom runs are unaffected: vitest does not process CSS by default, so
    // this changes what the dev server serves, not what the suite transforms.
    tailwindcss(),
    babel({
      include: REACT_COMPILER_REGRESSION_FILES,
      presets: [reactCompilerPreset()],
    }).then((plugin) => ({
      ...plugin,
      enforce: "post" as const,
    })),
  ],
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "src") },
      {
        find: "@traycer-clients/shared",
        replacement: path.resolve(__dirname, "..", "shared"),
      },
      {
        find: /^@traycer\/protocol\/utils\/(.*)$/,
        replacement: path.resolve(
          __dirname,
          "..",
          "..",
          "protocol",
          "utils",
          "$1",
        ),
      },
      {
        find: /^@traycer\/protocol\/(.*)$/,
        replacement: path.resolve(
          __dirname,
          "..",
          "..",
          "protocol",
          "src",
          "$1",
        ),
      },
      {
        find: /^@traycer\/html-source$/,
        replacement: path.resolve(
          __dirname,
          "..",
          "..",
          "packages",
          "html-source",
          "src",
          "index.ts",
        ),
      },
    ],
  },
  test: {
    // Vitest 5 flipped clearMocks to true; keep the v4 behavior (mock call history persists across tests).
    clearMocks: false,
    // Anchored to the package directory so siblings whose names merely
    // CONTAIN "zod" (`zod-to-json-schema`, `@hookform/resolvers/zod`) are
    // not dragged in. Full rationale for the workaround itself lives in
    // `clients/desktop/vitest.shared.ts`.
    server: { deps: { inline: [/[\\/]node_modules[\\/]zod[\\/]/] } },
    environment: "jsdom",
    setupFiles: ["./__tests__/test-browser-apis.ts"],
    include: [
      "__tests__/**/*.test.ts",
      "__tests__/**/*.test.tsx",
      "src/**/__tests__/**/*.test.ts",
      "src/**/__tests__/**/*.test.tsx",
    ],
    globals: false,
    pool: "forks",
    // A few suites advance large fake-timer windows. Limiting concurrently
    // running files keeps those timers responsive on CI's shared runners.
    maxWorkers: MAX_TEST_WORKERS,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Don't let a stray post-teardown async error (a timer/socket/microtask
    // rejecting after a test finished) fail the whole run with exit 1 and no
    // failing test - the classic intermittent CI flake. The setup file
    // (`__tests__/test-browser-apis.ts`) still logs every such error, so we keep
    // visibility instead of silently swallowing it.
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
