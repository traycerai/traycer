/// <reference types="node" />

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every preset theme's DARK variant defines `--muted` identical to
 * `--popover` and `--card`, and the flat light presets (github, gruvbox,
 * tokyo-night, nord, everforest) collapse it into `--background` too. Only
 * the default light/dark pair keeps the tokens apart - which is exactly why
 * a `bg-muted` fill on a raised surface looks correct in development and is
 * INVISIBLE for most users. It shipped that way once already (the usage
 * dialog's loading skeleton, a blank dialog body for every preset theme).
 *
 * The fix is an alpha of the foreground, which contrasts with whatever
 * surface it lands on by construction - see `clients/gui-app/AGENTS.md`.
 *
 * This guard is deliberately a coarse file-level heuristic rather than a
 * per-element check: a file that renders a raised surface AND names a muted
 * fill is the shape the audit kept finding, and no static rule can resolve
 * which ancestor a given `<div>` actually paints on. That means it can
 * over-report - a file may render a dialog in one branch and legitimately
 * tint a `bg-background` zone in another - so a genuine exception is added
 * to {@link GRANDFATHERED} with a reason rather than fought.
 */
const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Markers that this file paints a `--popover`/`--card`-valued surface. */
const RAISED_SURFACE =
  /DialogContent|PopoverContent|DropdownMenuContent|SheetContent|ContextMenuContent|bg-popover|bg-card/;

/** `bg-muted-foreground` is a TEXT color and is unaffected by the collapse. */
const MUTED_FILL = /bg-muted(?!-foreground)/;

/**
 * Files that already paired the two when this guard was written. These are
 * the audit's untriaged tail: each still has to be checked by hand against
 * the surface its fill really lands on, and the ones that turn out to be on
 * `bg-background`/`bg-canvas` are correct as they stand. The list may only
 * shrink - a new entry means a new instance of a bug we have already shipped
 * to users once.
 */
const GRANDFATHERED: ReadonlySet<string> = new Set([
  "components/chat/chat-accumulated-changes-panel.tsx",
  "components/chat/chat-turn-minimap.tsx",
  "components/chat/segments/restore-checkpoint-dialog.tsx",
  "components/chat/segments/setup-card-segment.tsx",
  "components/diff/file-autosave-status.tsx",
  "components/epic-canvas/canvas/tab-strip.tsx",
  "components/epic-canvas/git-diff/diff-tab-toolbar.tsx",
  "components/epic-canvas/panels/epic-sharing/my-agents-section.tsx",
  "components/epic-canvas/renderers/story-tile.tsx",
  "components/epic-canvas/renderers/terminal-agent-fork-dialog.tsx",
  "components/epic-canvas/renderers/ticket-tile.tsx",
  "components/epic-canvas/renderers/tui-agent-tile.tsx",
  "components/epic-tabs/phase-migration-surface.tsx",
  "components/epics/delete-tasks-dialog.tsx",
  "components/epics/epics-list-panel.tsx",
  "components/home/composer/composer-shell.tsx",
  "components/home/host-workspace-selector/workspace-summary-trigger.tsx",
  "components/host/host-busy-force-defer-dialog.tsx",
  "components/layout/dialogs/desktop/logs-chooser-dialog.tsx",
  "components/layout/header/rate-limit-popover.tsx",
  "components/layout/header/sign-in/device-code-progress.tsx",
  "components/onboarding/onboarding-diorama.tsx",
  "components/providers/profile-usage-sidecar.tsx",
  "components/settings/controls/terminal-cursor-style-picker.tsx",
  "components/settings/controls/theme-mode-toggle.tsx",
  "components/settings/host-scope/host-config-notices.tsx",
  "components/settings/panels/diagnostics-log-entries.tsx",
  "components/settings/panels/host-overview-status-card.tsx",
  "components/settings/panels/provider-cli-candidates-section.tsx",
  "components/settings/panels/provider-model-provider-connect-dialog.tsx",
  "components/settings/panels/provider-profile-scoped-section.tsx",
  "components/settings/panels/provider-skill-composer-dialog.tsx",
  "components/settings/panels/provider-skill-detail-dialog.tsx",
  "components/settings/panels/provider-skills-tab.tsx",
  "components/settings/panels/usage-settings-panel.tsx",
  "components/settings/panels/worktrees-settings-panel.tsx",
  "components/worktree/worktree-pr-metadata.tsx",
]);

/** Comments explain the collapse; they are not markup. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[^\n]*?\/\/[^\n]*$/gm, "");
}

function collectTsxFiles(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      found.push(...collectTsxFiles(full));
      continue;
    }
    if (entry.endsWith(".tsx")) found.push(full);
  }
  return found;
}

describe("muted fills on raised surfaces", () => {
  it("no NEW component pairs a raised surface with a bg-muted fill", () => {
    const offenders = collectTsxFiles(SRC_DIR)
      .filter((file) => {
        const source = stripComments(readFileSync(file, "utf8"));
        return RAISED_SURFACE.test(source) && MUTED_FILL.test(source);
      })
      .map((file) => path.relative(SRC_DIR, file).split(path.sep).join("/"))
      .filter((file) => !GRANDFATHERED.has(file));

    expect(offenders).toEqual([]);
  });

  it("the grandfathered list only shrinks", () => {
    const stillPaired = new Set(
      collectTsxFiles(SRC_DIR)
        .filter((file) => {
          const source = stripComments(readFileSync(file, "utf8"));
          return RAISED_SURFACE.test(source) && MUTED_FILL.test(source);
        })
        .map((file) => path.relative(SRC_DIR, file).split(path.sep).join("/")),
    );
    // A fixed file left behind in the list would silently re-open the hole
    // it was removed for, so retire entries as they are cleaned up.
    const staleEntries = [...GRANDFATHERED].filter(
      (file) => !stillPaired.has(file),
    );

    expect(staleEntries).toEqual([]);
  });
});

describe("raised-surface primitives", () => {
  const readPrimitive = (file: string): string =>
    stripComments(
      readFileSync(path.join(SRC_DIR, "components/ui", file), "utf8"),
    );

  it.each([
    ["skeleton.tsx"],
    ["dialog.tsx"],
    ["card.tsx"],
    ["command.tsx"],
    ["button.tsx"],
    ["badge.tsx"],
    ["avatar.tsx"],
    ["kbd.tsx"],
    ["button-group.tsx"],
    ["confirm-destructive-dialog.tsx"],
    ["select-all-toggle.tsx"],
  ])(
    "%s carries no muted fill - it is mounted on surfaces it cannot know",
    (file) => {
      expect(MUTED_FILL.test(readPrimitive(file))).toBe(false);
    },
  );

  it("Skeleton defaults to a surface-independent fill", () => {
    expect(readPrimitive("skeleton.tsx")).toContain("bg-foreground/10");
  });
});
