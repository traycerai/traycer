import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * A chord names a PLACE on the keyboard, and every matcher that resolves a
 * REGISTERED BINDING must agree on that.
 *
 * The rule, and its exception, are two halves of one argument:
 *
 * - A binding is STORED as a position token minted from `event.code`, so it has
 *   to be read back from `code`. Reading it from `key` matches whatever
 *   character the layout produces there instead - on AZERTY the physical
 *   `KeyW` reports `key: "z"`.
 * - A PLATFORM CONVENTION is the mirror image. Mod+Z means undo on the key
 *   LABELLED Z, and paste happens wherever the reader's layout puts V, because
 *   that is where the browser's own paste is bound. Moving those to `code`
 *   would not extend the fix, it would introduce the same bug with the polarity
 *   reversed - a French reader pressing the key marked Z would get whatever US
 *   has in that position.
 *
 * So neither `key` nor `code` is "correct" on its own; which one is correct
 * follows from whether the site resolves one of OUR tokens or a convention that
 * belongs to the platform.
 *
 * This file exists because "we fixed the class" has been wrong twice. Round 15
 * moved two matchers onto `code` and called the class closed; the streamed
 * screencast matcher was still on `key`. Fixing that at the shared point then
 * swept the PASTE caller physical too, breaking native paste on Dvorak - the
 * same mistake with the sign flipped. Both times the completeness claim lived
 * in a comment, and a comment cannot be contradicted by anything.
 *
 * ## What this test actually establishes, precisely
 *
 * It inventories READS of a keyboard event's `key` - not comparisons - so the
 * shape of the read does not matter: `event.key === "w"`, `const { key } =
 * event`, `switch (event.key)`, `helper(event.key)`, `event["key"]` and
 * `"w" === event.key` all count alike. An expression counts as a keyboard
 * event when, in the same file, it is also used like one (`.code`, `.ctrlKey`,
 * `.repeat`, ...) or is passed to a helper that takes a `KeyboardEvent`, and
 * that helper list is DERIVED from the sources rather than restated here.
 *
 * It does NOT establish that no keyboard `key` read exists anywhere - the
 * blind spots it cannot see are pinned by their own tests at the bottom of
 * this file, so the limit is executable rather than prose.
 */

const CLIENTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
);

/**
 * The matchers that resolve one of our own tokens, each with the FUNCTION that
 * has to do the deriving. Naming the function matters: `normalizeCode` merely
 * appearing in a file says nothing about whether this matcher uses the result.
 */
const CODE_DERIVED_MATCHERS: ReadonlyArray<{
  readonly file: string;
  readonly fn: string;
  readonly what: string;
}> = [
  {
    file: "gui-app/src/lib/keybindings/chord.ts",
    fn: "parseChordFromEvent",
    what: "the renderer's app-registry matcher",
  },
  {
    file: "gui-app/src/lib/keybindings/chord.ts",
    fn: "parseChordFromEventCtrlAware",
    what: "the renderer's ctrl-aware matcher",
  },
  {
    file: "gui-app/src/lib/browser-view/sessions/screencast-input-encoding.ts",
    fn: "isScreencastModChord",
    what: "the STREAMED screencast matcher",
  },
  {
    file: "desktop/src/electron-main/browser-view/manager/browser-view-chords.ts",
    fn: "chordKeyFromInput",
    what: "the native guest matcher in Electron main",
  },
  {
    file: "gui-app/src/hooks/composer/use-dictation-hotkey.ts",
    fn: "chordMatchesStrict",
    what: "the dictation hotkey matcher",
  },
];

/**
 * Every read of a keyboard event's `key` in the client sources, by file.
 *
 * The COUNT is part of the assertion: a second read added to a file that
 * already appears here changes the number and fails, which a per-file set of
 * characters could not detect.
 */
const KEYBOARD_KEY_READS: Readonly<Record<string, number>> = {
  "desktop/src/electron-main/browser-view/annotation/browser-annotation-overlay-guest.ts": 3,
  "desktop/src/electron-main/browser-view/manager/browser-view-chords.ts": 1,
  // These reads drive viewport editing and resize-handle navigation. They do
  // not resolve registered shortcut identity, which remains code-derived.
  "gui-app/src/components/browser-tile/browser-viewport-handles.tsx": 6,
  "gui-app/src/components/browser-tile/browser-viewport-toolbar.tsx": 5,
  "gui-app/src/components/chat/chat-messages.tsx": 10,
  "gui-app/src/components/chat/composer/menu/github-mention-filter-popover.tsx": 3,
  "gui-app/src/components/chat/composer/picker/suggestion-render.ts": 5,
  "gui-app/src/components/chat/composer/profile-rate-limit-switch-banner.tsx": 3,
  "gui-app/src/components/chat/composer/prompt-stash-control.tsx": 7,
  "gui-app/src/components/chat/segments/pending-interview/use-interview-card.ts": 5,
  "gui-app/src/components/chat/segments/revert-on-edit-dialog.tsx": 1,
  "gui-app/src/components/chat/segments/steer-settings-conflict-dialog.tsx": 1,
  "gui-app/src/components/comments/comment-composer.tsx": 2,
  "gui-app/src/components/diff/use-diff-click-to-edit.ts": 1,
  "gui-app/src/components/epic-canvas/canvas/pane-opener.tsx": 1,
  "gui-app/src/components/epic-canvas/canvas/tab-strip.tsx": 2,
  "gui-app/src/components/epic-canvas/comm-graph/office/comm-graph-office-canvas.tsx": 1,
  "gui-app/src/components/epic-canvas/image-preview/image-preview.tsx": 7,
  "gui-app/src/components/epic-canvas/pdf-preview/pdf-preview.tsx": 2,
  "gui-app/src/components/epic-canvas/pip/agent-browser-pip.tsx": 6,
  "gui-app/src/components/epic-canvas/renderers/managed-command-output-tile.tsx": 3,
  "gui-app/src/components/epic-canvas/renderers/terminal-tile-xterm.tsx": 5,
  "gui-app/src/components/epic-canvas/sidebar/epic-browser-sidebar-row.tsx": 1,
  "gui-app/src/components/epic-canvas/sidebar/epic-sidebar-artifact-tree.tsx": 2,
  "gui-app/src/components/epic-canvas/sidebar/epic-sidebar-artifact-search.tsx": 9,
  "gui-app/src/components/epic-canvas/sidebar/epic-sidebar-chat-tree.tsx": 3,
  "gui-app/src/components/epic-canvas/sidebar/epic-sidebar-filter.ts": 2,
  "gui-app/src/components/epic-canvas/tile-find/tile-find-bar.tsx": 3,
  "gui-app/src/components/epic-canvas/tile-select-all-bridge.tsx": 2,
  "gui-app/src/components/epics/epics-list-panel.tsx": 2,
  "gui-app/src/components/layout/find-in-page-bar.tsx": 2,
  "gui-app/src/components/layout/header/windows-menu-bar.tsx": 3,
  "gui-app/src/components/layout/tabs/tab-group-chip.tsx": 4,
  "gui-app/src/components/onboarding/onboarding-page.tsx": 4,
  "gui-app/src/components/providers/profile-dropdown.tsx": 4,
  "gui-app/src/components/remote-folder-picker-dialog.tsx": 4,
  "gui-app/src/components/resources/resource-monitor-popover.tsx": 9,
  "gui-app/src/components/settings/controls/chord-capture-core.tsx": 2,
  "gui-app/src/components/worktree/worktree-pr-state-icons.tsx": 2,
  "gui-app/src/editor-core/links/artifact-link-popover.tsx": 3,
  "gui-app/src/editor-core/nodes/mermaid/pan-zoom-svg-viewer.tsx": 7,
  "gui-app/src/hooks/use-primary-action-shortcut.ts": 1,
  "gui-app/src/lib/browser-view/sessions/screencast-controller.ts": 4,
  "gui-app/src/lib/browser-view/sessions/screencast-input-encoding.ts": 2,
  "gui-app/src/lib/keybindings/bare-key-owner.ts": 1,
  "gui-app/src/lib/keybindings/chord.ts": 4,
  "gui-app/src/lib/notifications/notification-feed-keyboard-navigation.ts": 1,
  "gui-app/src/lib/terminal-line-edit.ts": 6,
  "gui-app/src/providers/keybinding-provider.tsx": 2,
};

/**
 * Of those, the ones that match a PRINTABLE character, with the reason each
 * may. None resolve a registered chord token; every one is a convention keyed
 * to the character the reader sees, so `key` is not a lapse there but the
 * requirement. A site that ever joins the chord registry has to move to `code`
 * and leave this table.
 */
const PRINTABLE_CHARACTER_MATCHES: Readonly<
  Record<
    string,
    { readonly chars: ReadonlyArray<string>; readonly why: string }
  >
> = {
  "gui-app/src/providers/keybinding-provider.tsx": {
    chars: ["k", "z"],
    why: "platform mod+letter conventions, matched where the letter is",
  },
  "gui-app/src/editor-core/links/artifact-link-popover.tsx": {
    chars: ["k"],
    why: "platform mod+K convention",
  },
  "gui-app/src/components/epic-canvas/tile-find/tile-find-bar.tsx": {
    chars: ["g"],
    why: "platform mod+G find-again convention",
  },
  "gui-app/src/components/diff/use-diff-click-to-edit.ts": {
    chars: ["s"],
    why: "platform mod+S save convention",
  },
  "gui-app/src/components/epic-canvas/tile-select-all-bridge.tsx": {
    chars: ["A", "a"],
    why: "platform mod+A select-all convention",
  },
  "gui-app/src/lib/browser-view/sessions/screencast-input-encoding.ts": {
    chars: ["v"],
    why: "the clipboard paste convention - see isScreencastPasteChord",
  },
  "gui-app/src/components/chat/composer/profile-rate-limit-switch-banner.tsx": {
    chars: ["r"],
    why: "single-letter accelerator on a visible label inside an open banner",
  },
  "gui-app/src/components/providers/profile-dropdown.tsx": {
    chars: ["r"],
    why: "single-letter accelerator on a visible label inside an open menu",
  },
  "gui-app/src/components/chat/composer/prompt-stash-control.tsx": {
    chars: ["d"],
    why: "single-letter accelerator on a visible label inside an open menu",
  },
  "gui-app/src/components/epic-canvas/image-preview/image-preview.tsx": {
    chars: ["+", "-", "0", "=", "F", "_", "f"],
    why: "unmodified viewer keys: the character typed IS the request, and both spellings are accepted precisely because layouts differ",
  },
  "gui-app/src/editor-core/nodes/mermaid/pan-zoom-svg-viewer.tsx": {
    chars: ["+", "-", "0", "=", "F", "_", "f"],
    why: "unmodified viewer keys, as above",
  },
  "gui-app/src/components/epic-canvas/comm-graph/office/comm-graph-office-canvas.tsx":
    {
      chars: ["+", "-", "0", "=", "F", "f"],
      // The two pairs are NOT accepted for one reason, so they are not stated as
      // one: conflating them is how a later reader concludes the office tolerates
      // any spelling of anything, and adds a case that does resolve a chord.
      why: "unmodified keys on the focused floor - no modifier is involved, so the character typed IS the request, and none of them resolve a registered chord. The pairs differ: +/= is ONE physical key whose unshifted character most layouts make =, while f/F is one character in either case, so caps lock or a held shift still fits the floor",
    },
};

/** Properties only a keyboard event carries. */
const KEYBOARD_PROPERTIES: ReadonlySet<string> = new Set([
  "code",
  "ctrlKey",
  "metaKey",
  "altKey",
  "shiftKey",
  "repeat",
  "isComposing",
  "getModifierState",
]);

interface ScanSource {
  readonly name: string;
  readonly text: string;
}

interface KeyReadScan {
  readonly reads: Readonly<Record<string, number>>;
  readonly chars: Readonly<Record<string, ReadonlyArray<string>>>;
}

function parse(source: ScanSource): ts.SourceFile {
  return ts.createSourceFile(
    source.name,
    source.text,
    ts.ScriptTarget.Latest,
    true,
    source.name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * The functions that take a `KeyboardEvent`, read out of the sources rather
 * than listed here - so a new one joins the scan's notion of "this expression
 * is a keyboard event" without anyone remembering to update a list.
 */
function keyboardEventHelpers(
  sources: ReadonlyArray<ScanSource>,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const source of sources) {
    const file = parse(source);
    const walk = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
        const first = node.parameters.at(0);
        if (
          first?.type !== undefined &&
          /KeyboardEvent/.test(first.type.getText(file))
        ) {
          names.add(node.name.text);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(file);
  }
  return names;
}

/** The object expression a `key` read hangs off, or null if this is not one. */
function keyReadTarget(node: ts.Node, file: ts.SourceFile): string | null {
  if (ts.isPropertyAccessExpression(node) && node.name.text === "key") {
    return node.expression.getText(file);
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteral(node.argumentExpression) &&
    node.argumentExpression.text === "key"
  ) {
    return node.expression.getText(file);
  }
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const name = node.propertyName ?? node.name;
    const declaration = node.parent.parent;
    if (
      ts.isIdentifier(name) &&
      name.text === "key" &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined
    ) {
      return declaration.initializer.getText(file);
    }
  }
  return null;
}

/** Expressions this file uses as keyboard events. */
function keyboardExpressions(
  file: ts.SourceFile,
  helpers: ReadonlySet<string>,
): ReadonlySet<string> {
  const found = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      KEYBOARD_PROPERTIES.has(node.name.text)
    ) {
      found.add(node.expression.getText(file));
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      helpers.has(node.expression.text)
    ) {
      for (const argument of node.arguments) found.add(argument.getText(file));
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return found;
}

/**
 * A single printable character this `key` read is compared against.
 *
 * Ascends the call chain first, so `event.key.toLowerCase() === "k"` is read as
 * a comparison of the key and not of `toLowerCase`. Missing that was what made
 * the first version of this scan see three of the eleven real sites.
 */
function printableCharacter(node: ts.Node): string | null {
  if (!ts.isStringLiteral(node)) return null;
  if (node.text.length !== 1 || node.text === " ") return null;
  return node.text;
}

function comparedCharacters(node: ts.Node): ReadonlyArray<string> {
  let expression: ts.Node = node;
  while (
    (ts.isPropertyAccessExpression(expression.parent) ||
      ts.isCallExpression(expression.parent)) &&
    expression.parent.expression === expression
  ) {
    expression = expression.parent;
  }
  const parent = expression.parent;
  if (ts.isBinaryExpression(parent)) {
    const other = parent.left === expression ? parent.right : parent.left;
    const character = printableCharacter(other);
    return character === null ? [] : [character];
  }
  // `switch (event.key)` - the literals hang off the case clauses, not off the
  // read, so the switch has to be walked rather than the read's parent.
  if (ts.isSwitchStatement(parent) && parent.expression === expression) {
    const found: Array<string> = [];
    for (const clause of parent.caseBlock.clauses) {
      if (!ts.isCaseClause(clause)) continue;
      const character = printableCharacter(clause.expression);
      if (character !== null) found.push(character);
    }
    return found;
  }
  return [];
}

function scanKeyReads(
  sources: ReadonlyArray<ScanSource>,
  helpers: ReadonlySet<string>,
): KeyReadScan {
  const reads: Record<string, number> = {};
  const chars: Record<string, ReadonlyArray<string>> = {};
  for (const source of sources) {
    const file = parse(source);
    const keyboards = keyboardExpressions(file, helpers);
    let count = 0;
    const seen = new Set<string>();
    const walk = (node: ts.Node): void => {
      const target = keyReadTarget(node, file);
      if (target !== null && keyboards.has(target)) {
        count += 1;
        for (const character of comparedCharacters(node)) seen.add(character);
      }
      ts.forEachChild(node, walk);
    };
    walk(file);
    if (count > 0) reads[source.name] = count;
    if (seen.size > 0) chars[source.name] = [...seen].sort();
  }
  return { reads, chars };
}

function sourceFiles(dir: string): ReadonlyArray<string> {
  const found: Array<string> = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith(".ts") || entry.endsWith(".tsx")) found.push(full);
    }
  };
  walk(dir);
  return found;
}

function clientSources(): ReadonlyArray<ScanSource> {
  const sources: Array<ScanSource> = [];
  for (const root of [
    path.join(CLIENTS_DIR, "gui-app", "src"),
    path.join(CLIENTS_DIR, "desktop", "src"),
    path.join(CLIENTS_DIR, "shared"),
  ]) {
    for (const file of sourceFiles(root)) {
      sources.push({
        name: path.relative(CLIENTS_DIR, file),
        text: readFileSync(file, "utf8"),
      });
    }
  }
  return sources;
}

/** The body text of one named function declaration. */
function functionBody(source: ScanSource, name: string): string | null {
  const file = parse(source);
  let body: string | null = null;
  const walk = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === name &&
      node.body !== undefined
    ) {
      body = node.body.getText(file);
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return body;
}

const CLIENT_SOURCES = clientSources();
const CLIENT_HELPERS = keyboardEventHelpers(CLIENT_SOURCES);

/**
 * Scan a snippet with the REAL helper set, since that is what the scan runs
 * with - deriving helpers from the snippet alone would test a scanner nobody
 * uses, and would quietly pass the one form that depends on the helper list.
 */
function syntheticScan(text: string): KeyReadScan {
  return scanKeyReads([{ name: "synthetic.ts", text }], CLIENT_HELPERS);
}

describe("every chord matcher derives from the physical key", () => {
  const sources = CLIENT_SOURCES;
  const helpers = CLIENT_HELPERS;
  const scan = scanKeyReads(sources, helpers);

  it.each(CODE_DERIVED_MATCHERS)(
    "$what derives from code, inside $fn itself",
    ({ file, fn }) => {
      const source = {
        name: file,
        text: readFileSync(path.join(CLIENTS_DIR, file), "utf8"),
      };
      const body = functionBody(source, fn);

      // The function has to exist - a rename must fail here rather than
      // silently stop checking anything.
      expect(body).not.toBeNull();

      // A CALL-LOCATION guard, and nothing more: it pins that the derivation
      // happens inside this function, so hoisting it out or dropping it is
      // caught. It does NOT establish that the result is what the matcher then
      // uses - `normalizeCode(event.code) && event.key.toLowerCase()` keeps
      // this green while breaking the match. The behaviour is pinned by the
      // per-layout tests in browser-view-chords.test.ts and the screencast
      // shortcut tests; this assertion exists to catch the refactor that
      // silently relocates the call, not to prove semantics.
      expect(body).toContain("normalizeCode(");
    },
  );

  it("derives the keyboard-event helper list from the sources", () => {
    // The scan's notion of "this is a keyboard event" leans on this set, so an
    // empty or tiny one would quietly shrink the inventory.
    expect(helpers.has("hasPlatformModKey")).toBe(true);
    expect(helpers.has("isScreencastModChord")).toBe(true);
    expect(helpers.has("isScreencastPasteChord")).toBe(true);
    expect(helpers.size).toBeGreaterThan(8);
  });

  it("inventories every read of a keyboard event's key", () => {
    expect(scan.reads).toEqual(KEYBOARD_KEY_READS);
  });

  it("classifies every printable character matched against a keyboard key", () => {
    const classified = Object.fromEntries(
      Object.entries(PRINTABLE_CHARACTER_MATCHES).map(([file, entry]) => [
        file,
        entry.chars,
      ]),
    );

    expect(scan.chars).toEqual(classified);
  });

  it("gives every printable-character site a stated reason", () => {
    for (const [file, entry] of Object.entries(PRINTABLE_CHARACTER_MATCHES)) {
      expect(entry.why.length, file).toBeGreaterThan(20);
    }
  });
});

describe("the key-read scan sees every shape a read can take", () => {
  // Each of these is a form a previous regex-based scan missed. They are
  // statements, not comments, so comment handling is not what covers them -
  // the scan counts the READ and does not care what is done with the value.
  const FORMS: ReadonlyArray<{ readonly what: string; readonly code: string }> =
    [
      {
        what: "a plain comparison",
        code: `if (event.ctrlKey && event.key === "w") act();`,
      },
      {
        what: "a reversed comparison",
        code: `if (event.ctrlKey && "w" === event.key) act();`,
      },
      {
        what: "a comparison against a variable",
        code: `const want = "w";\nif (event.ctrlKey && event.key === want) act();`,
      },
      {
        what: "a destructured read",
        code: `const { key } = event;\nif (event.ctrlKey && key === "w") act();`,
      },
      {
        what: "a read passed to a helper",
        code: `if (event.ctrlKey) act(event.key);`,
      },
      {
        what: "a switch on the key",
        code: `if (event.ctrlKey) switch (event.key) { case "w": act(); }`,
      },
      {
        what: "a bracket access",
        code: `if (event.ctrlKey && event["key"] === "w") act();`,
      },
      {
        what: "a read reached only through a KeyboardEvent-typed helper",
        code: `if (hasPlatformModKey(event) && event.key === "w") act();`,
      },
    ];

  it.each(FORMS)("sees $what", ({ code }) => {
    const scanned = syntheticScan(code);

    expect(scanned.reads["synthetic.ts"]).toBeGreaterThanOrEqual(1);
  });

  it("sees the character in the forms that name one", () => {
    // Not every form above exposes a literal to classify - a variable
    // comparison and a helper call deliberately do not - so this pins the ones
    // that do, and the classification table above rests on exactly this.
    expect(syntheticScan(FORMS[0].code).chars["synthetic.ts"]).toEqual(["w"]);
    expect(syntheticScan(FORMS[1].code).chars["synthetic.ts"]).toEqual(["w"]);
    expect(syntheticScan(FORMS[5].code).chars["synthetic.ts"]).toEqual(["w"]);
  });

  it("counts an ADDITIONAL read in a file it already knows about", () => {
    const one = syntheticScan(`if (event.ctrlKey && event.key === "w") act();`);
    const two = syntheticScan(
      `if (event.ctrlKey && event.key === "w") act();\nif (event.key === "w") other();`,
    );

    // The count, not the character set, is what makes this detectable: both
    // files match only "w".
    expect(one.chars["synthetic.ts"]).toEqual(two.chars["synthetic.ts"]);
    expect(two.reads["synthetic.ts"]).toBe(one.reads["synthetic.ts"] + 1);
  });
});

describe("what the key-read scan cannot see", () => {
  // Documented executably rather than in prose, because a comment claiming
  // completeness is what failed here twice - and then a third time: the first
  // version of THIS block listed four limits and had nine, which is the same
  // defect one level up. Each case below WILL slip past the inventory; if one
  // day a case starts being seen, this test fails and the limit gets narrowed
  // on purpose rather than by accident.
  //
  // The boundaries are syntactic, and stating them as such is what keeps the
  // list honest: a read is seen only as `<expr>.key`, `<expr>["key"]`, or an
  // Identifier binding element in a variable destructure; `<expr>` must match
  // by SOURCE TEXT something the same file used as a keyboard event through a
  // property access or passed to a KeyboardEvent-typed function declaration.

  it("cannot see a key read on a value it never sees used as a keyboard event", () => {
    // Nothing in this file reads `.code`/`.ctrlKey` off `thing`, and no
    // KeyboardEvent-typed helper is called with it.
    const scanned = syntheticScan(`if (thing.key === "w") act();`);

    expect(scanned.reads["synthetic.ts"]).toBeUndefined();
  });

  it("cannot see a key read through a computed property name", () => {
    const scanned = syntheticScan(
      `const prop = "key";\nif (event.ctrlKey && event[prop] === "w") act();`,
    );

    expect(scanned.reads["synthetic.ts"]).toBeUndefined();
  });

  it("cannot see a destructure whose source it cannot name", () => {
    // A parameter destructure has no initializer to attribute the read to.
    const scanned = syntheticScan(
      `const onKey = ({ key }: KeyboardEvent): void => { act(key); };`,
    );

    expect(scanned.reads["synthetic.ts"]).toBeUndefined();
  });

  it("cannot see a destructure whose property name is a string literal", () => {
    // The binding element's property name must be an Identifier. The source is
    // perfectly nameable here, so the limit above does not cover this one.
    const scanned = syntheticScan(
      `const { "key": key } = event;\nif (event.ctrlKey && key === "w") act();`,
    );

    expect(scanned.reads["synthetic.ts"]).toBeUndefined();
  });

  it("cannot see a destructure that assigns instead of declaring", () => {
    // Only a VariableDeclaration carries an initializer to attribute to; an
    // assignment pattern is an ExpressionStatement.
    const scanned = syntheticScan(
      `let key;\n({ key } = event);\nif (event.ctrlKey && key === "w") act();`,
    );

    expect(scanned.reads["synthetic.ts"]).toBeUndefined();
  });

  it("cannot match a keyboard expression whose source text differs", () => {
    // `event.ctrlKey` registers the text `event`; the read hangs off `(event)`.
    // Matching is textual, so a redundant paren is enough to lose it.
    const scanned = syntheticScan(
      `if (event.ctrlKey && (event).key === "w") act();`,
    );

    expect(scanned.reads["synthetic.ts"]).toBeUndefined();
  });

  it("cannot recognise a keyboard event from a bracketed modifier read", () => {
    // A `key` READ counts through `event["key"]`, but the evidence that makes
    // `event` a keyboard event is property-access only - so this file looks
    // like it has no keyboard event in it at all.
    const scanned = syntheticScan(
      `if (event["ctrlKey"] && event.key === "w") act();`,
    );

    expect(scanned.reads["synthetic.ts"]).toBeUndefined();
  });

  it("cannot follow the key past the site it was read at", () => {
    // Stated as "out of the FILE" once, which was wider than the truth: the
    // character is classified from the read's own expression upwards, so a
    // same-file helper loses it exactly as an imported one does.
    const sameFile = syntheticScan(
      `function decide(c: string): void { if (c === "w") act(); }\nif (event.ctrlKey) decide(event.key);`,
    );
    const otherFile = syntheticScan(`if (event.ctrlKey) decide(event.key);`);

    expect(sameFile.reads["synthetic.ts"]).toBeGreaterThanOrEqual(1);
    expect(sameFile.chars["synthetic.ts"]).toBeUndefined();
    expect(otherFile.chars["synthetic.ts"]).toBeUndefined();
  });

  it("cannot follow the key through a local destructured binding", () => {
    // The read IS counted - it is in the shapes block above - but the
    // comparison hangs off the local `key`, not off the read, so nothing
    // classifies the character.
    const scanned = syntheticScan(
      `const { key } = event;\nif (event.ctrlKey && key === "w") act();`,
    );

    expect(scanned.reads["synthetic.ts"]).toBeGreaterThanOrEqual(1);
    expect(scanned.chars["synthetic.ts"]).toBeUndefined();
  });
});

describe("what the keyboard-event helper derivation cannot see", () => {
  // The derived helper set is the scan's other input, and it has its own
  // boundary: a FUNCTION DECLARATION whose FIRST parameter is typed
  // KeyboardEvent. Everything else contributes nothing, so a read reachable
  // only through such a helper is invisible for that reason rather than for
  // any of the reasons above.

  const derive = (text: string): ReadonlySet<string> =>
    keyboardEventHelpers([{ name: "synthetic.ts", text }]);

  it("sees a function declaration whose first parameter is the event", () => {
    // The positive control: without this passing, the misses below prove
    // nothing except that the probe never ran.
    expect(
      derive(`function onKey(event: KeyboardEvent): void { act(event); }`),
    ).toContain("onKey");
  });

  it.each([
    {
      what: "an arrow function",
      code: `const onKey = (event: KeyboardEvent): void => { act(event); };`,
    },
    {
      what: "a function expression",
      code: `const onKey = function (event: KeyboardEvent): void { act(event); };`,
    },
    {
      what: "a declaration whose event is not the first parameter",
      code: `function onKey(which: string, event: KeyboardEvent): void { act(which, event); }`,
    },
    {
      what: "a declaration with no parameter type at all",
      code: `function onKey(event): void { act(event); }`,
    },
  ])("does not derive a helper from $what", ({ code }) => {
    expect(derive(code).has("onKey")).toBe(false);
  });
});
