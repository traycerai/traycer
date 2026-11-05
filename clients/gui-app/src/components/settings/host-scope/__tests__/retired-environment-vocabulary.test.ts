import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

type MatchKind = "phrase" | "exact-label";

type VocabularyCell = {
  readonly replaces: string;
  readonly matches: ReadonlyArray<{
    readonly copy: string;
    readonly kind: MatchKind;
  }>;
  readonly guidance?: string;
};

type CopyLiteral = {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly context: string;
};

type CopyPiece = { readonly node: ts.Node; readonly text: string };
type VocabularyHit = CopyLiteral & { readonly copy: string };
type VocabularyAllowance = {
  readonly file: string;
  readonly texts: ReadonlyArray<string>;
};

const SOURCE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../",
);
const ROOT = SOURCE_ROOT;
const COPY_ATTRIBUTES = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "description",
  "helperText",
  "hint",
  "label",
  "message",
  "placeholder",
  "title",
  "tooltip",
]);
const COPY_PROPERTIES = new Set([
  "description",
  "error",
  "hint",
  "label",
  "loading",
  "message",
  "pending",
  "problem",
  "success",
  "title",
]);

// Oracle copied from the “Replaces” column in core-flows/index.html. Phrase
// entries use case-insensitive whole-word matching; contextual labels match
// only as whole rendered text or string literals. A word the table Says or the
// locked board draws is not banned: Host and Teams are valid labels, as is the
// background credential kind badge.
const VOCABULARY: ReadonlyArray<VocabularyCell> = [
  {
    replaces: 'the aggregate senses of device, machine, team pod, "run on"',
    matches: [
      { copy: "team pod", kind: "phrase" },
      { copy: "run on", kind: "exact-label" },
    ],
    guidance: "device and machine are retired only in aggregate-host senses.",
  },
  {
    replaces: "This computer as a primary label; device; machine",
    matches: [{ copy: "This computer", kind: "exact-label" }],
    guidance: "device and machine are not blanket bans.",
  },
  {
    replaces: "Sandbox host, team pod, pod",
    matches: [
      { copy: "Sandbox host", kind: "phrase" },
      { copy: "team pod", kind: "phrase" },
      { copy: "pod", kind: "exact-label" },
    ],
  },
  {
    replaces: "Individual, Teams",
    matches: [{ copy: "Individual", kind: "exact-label" }],
    guidance: "Teams remains the environment-picker group heading.",
  },
  {
    replaces:
      'Local as a badge; and every surface that says "Personal" here today',
    matches: [{ copy: "Local", kind: "exact-label" }],
    guidance: "Personal is valid in other contexts and is not a blanket ban.",
  },
  { replaces: "Frozen", matches: [{ copy: "Frozen", kind: "phrase" }] },
  {
    replaces: "Resting",
    matches: [
      { copy: "Resting", kind: "phrase" },
      { copy: "rests", kind: "phrase" },
      { copy: "rested", kind: "phrase" },
    ],
  },
  {
    replaces: "the two folds and the chat rewrite",
    matches: [],
    guidance: "The replaced states are not named by this table cell.",
  },
  {
    replaces:
      "workspace collection, workspace folders, and the surfaces that each said their own thing",
    matches: [
      { copy: "workspace collection", kind: "phrase" },
      { copy: "workspace folders", kind: "phrase" },
    ],
  },
  {
    replaces:
      "dormant, inactive — and any borrowing of a sandbox lifecycle word",
    matches: [
      { copy: "dormant", kind: "phrase" },
      { copy: "inactive", kind: "phrase" },
    ],
    guidance:
      "Borrowing a sandbox lifecycle word is scoped guidance, not a ban.",
  },
  {
    replaces: "dormant, inactive, terminal not running",
    matches: [
      { copy: "dormant", kind: "phrase" },
      { copy: "inactive", kind: "phrase" },
      { copy: "terminal not running", kind: "phrase" },
    ],
  },
];

// Supplemental state wording: Starting up applies only when the report is null.
const ADDITIONAL_PHRASES = [
  { copy: "Personal host", kind: "phrase" },
  { copy: "Starting up", kind: "phrase" },
] as const satisfies ReadonlyArray<{
  readonly copy: string;
  readonly kind: MatchKind;
}>;

const ALLOWED_COPY: ReadonlyArray<VocabularyAllowance> = [
  // Worktree inactivity is not retired browser/terminal state.
  {
    file: "components/settings/panels/worktree-auto-cleanup-chip.tsx",
    texts: [
      "Removes worktrees on this host that have been inactive and stay proven safe to delete. Age alone never makes one safe.",
      "Inactive for",
    ],
  },
  // This is a captured log snapshot, not a sandbox state.
  {
    file: "components/layout/dialogs/desktop/report-issue-dialog.tsx",
    texts: ["Loading frozen tail...", "Could not load the frozen log tail."],
  },
  // This skill update policy names Frozen, not a sandbox state.
  {
    file: "components/settings/environment/mcp-skills-copy.ts",
    texts: [
      "Auto-update: follows upstream, cannot be edited here. Evolve: you and your agents can change it, updates wait for you. Frozen: nothing changes it.",
      "This skill can't be edited while it's set to Auto-update or Frozen. Switch it to Evolve to edit it.",
      "is set to Auto-update or Frozen, so it can't be replaced. Switch it to Evolve first.",
    ],
  },
  // The window's own host inside a sentence is not a primary label.
  {
    file: "components/settings/move/held-items-line-copy.ts",
    texts: ["this computer"],
  },
];

const ALL_MATCHES = [
  ...VOCABULARY.flatMap((cell) => cell.matches),
  ...ADDITIONAL_PHRASES,
];

function extractRenderedCopy(
  sourceText: string,
  filePath: string,
): CopyLiteral[] {
  const scriptKind = filePath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const declarations = new Map<string, ts.Expression>();
  const functionReturns = new Map<string, ReadonlyArray<ts.Expression>>();
  const pieces: CopyPiece[] = [];
  const seen = new Set<string>();

  function returnsFrom(body: ts.ConciseBody): ts.Expression[] {
    if (!ts.isBlock(body)) return [body];
    const values: ts.Expression[] = [];
    function visit(node: ts.Node): void {
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression !== undefined)
        values.push(node.expression);
      else ts.forEachChild(node, visit);
    }
    visit(body);
    return values;
  }

  function collectDeclarations(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const initializer = node.initializer;
      if (
        ts.isArrowFunction(initializer) ||
        ts.isFunctionExpression(initializer)
      ) {
        functionReturns.set(node.name.text, returnsFrom(initializer.body));
      } else {
        declarations.set(node.name.text, initializer);
      }
    } else if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      node.body !== undefined
    ) {
      functionReturns.set(node.name.text, returnsFrom(node.body));
    }
    ts.forEachChild(node, collectDeclarations);
  }

  function copyValues(
    expression: ts.Expression,
    resolving: ReadonlySet<string>,
  ): CopyPiece[] {
    if (
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression)
    ) {
      return [{ node: expression, text: expression.text }];
    }
    if (ts.isTemplateExpression(expression)) {
      return [
        { node: expression.head, text: expression.head.text },
        ...expression.templateSpans.flatMap((span) => [
          ...copyValues(span.expression, resolving),
          { node: span.literal, text: span.literal.text },
        ]),
      ];
    }
    return copyCompositeValues(expression, resolving);
  }

  function copyCompositeValues(
    expression: ts.Expression,
    resolving: ReadonlySet<string>,
  ): CopyPiece[] {
    if (ts.isObjectLiteralExpression(expression)) {
      return expression.properties.flatMap((property) => {
        if (
          !ts.isPropertyAssignment(property) ||
          !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        )
          return [];
        return COPY_PROPERTIES.has(property.name.text)
          ? copyValues(property.initializer, resolving)
          : [];
      });
    }
    if (ts.isConditionalExpression(expression)) {
      return [
        ...copyValues(expression.whenTrue, resolving),
        ...copyValues(expression.whenFalse, resolving),
      ];
    }
    if (ts.isBinaryExpression(expression))
      return copyBinaryValues(expression, resolving);
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression)
    ) {
      return copyValues(expression.expression, resolving);
    }
    if (ts.isIdentifier(expression))
      return copyIdentifierValues(expression, resolving);
    if (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression)
    ) {
      return copyCallValues(expression, expression.expression.text, resolving);
    }
    return [];
  }

  function copyBinaryValues(
    expression: ts.BinaryExpression,
    resolving: ReadonlySet<string>,
  ): CopyPiece[] {
    const operator = expression.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken)
      return copyValues(expression.right, resolving);
    if (
      operator === ts.SyntaxKind.PlusToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return [
        ...copyValues(expression.left, resolving),
        ...copyValues(expression.right, resolving),
      ];
    }
    return [];
  }

  function nextResolution(
    name: string,
    resolving: ReadonlySet<string>,
  ): ReadonlySet<string> | null {
    return resolving.has(name) ? null : new Set(resolving).add(name);
  }

  function copyIdentifierValues(
    expression: ts.Identifier,
    resolving: ReadonlySet<string>,
  ): CopyPiece[] {
    const name = expression.text;
    const next = nextResolution(name, resolving);
    if (next === null) return [];
    const initializer = declarations.get(name);
    if (initializer !== undefined) return copyValues(initializer, next);
    return (
      functionReturns.get(name)?.flatMap((value) => copyValues(value, next)) ??
      []
    );
  }

  function copyCallValues(
    expression: ts.CallExpression,
    name: string,
    resolving: ReadonlySet<string>,
  ): CopyPiece[] {
    if (name === "t" || name === "translate") {
      const message = expression.arguments.at(0);
      return message === undefined ? [] : copyValues(message, resolving);
    }
    const next = nextResolution(name, resolving);
    return next === null
      ? []
      : (functionReturns
          .get(name)
          ?.flatMap((value) => copyValues(value, next)) ?? []);
  }

  function add(node: ts.Node, text: string): void {
    if (text.trim().length === 0) return;
    const key = `${node.getStart(sourceFile)}:${node.end}:${text}`;
    if (!seen.has(key)) {
      seen.add(key);
      pieces.push({ node, text });
    }
  }

  function addExpression(expression: ts.Expression): void {
    for (const piece of copyValues(expression, new Set()))
      add(piece.node, piece.text);
  }

  function visit(node: ts.Node): void {
    collectJsxText(node);
    collectJsxAttribute(node);
    collectJsxExpression(node);
    collectCopyProperty(node);
    collectToastArguments(node);
    collectStandaloneCopy(node);
    ts.forEachChild(node, visit);
  }

  function hasExplicitStringReturn(type: ts.TypeNode | undefined): boolean {
    return type !== undefined && type.kind === ts.SyntaxKind.StringKeyword;
  }

  function isCopyLiteral(expression: ts.Expression): boolean {
    return (
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression) ||
      ts.isTemplateExpression(expression)
    );
  }

  function isExportedConst(node: ts.VariableDeclaration): boolean {
    if (!ts.isVariableDeclarationList(node.parent)) return false;
    if ((node.parent.flags & ts.NodeFlags.Const) === 0) return false;
    if (!ts.isVariableStatement(node.parent.parent)) return false;
    return (
      node.parent.parent.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ) === true
    );
  }

  function collectStringReturningFunction(
    name: string,
    type: ts.TypeNode | undefined,
  ): void {
    if (!hasExplicitStringReturn(type)) return;
    functionReturns.get(name)?.forEach(addExpression);
  }

  function collectFunctionDeclaration(node: ts.FunctionDeclaration): void {
    if (node.name === undefined) return;
    collectStringReturningFunction(node.name.text, node.type);
  }

  function collectVariableCopy(node: ts.VariableDeclaration): void {
    if (node.initializer === undefined) return;
    const initializer = node.initializer;
    if (isExportedConst(node) && isCopyLiteral(initializer))
      addExpression(initializer);
    if (!ts.isIdentifier(node.name)) return;
    if (
      !ts.isArrowFunction(initializer) &&
      !ts.isFunctionExpression(initializer)
    )
      return;
    collectStringReturningFunction(node.name.text, initializer.type);
  }

  function collectStandaloneCopy(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node)) {
      collectFunctionDeclaration(node);
      return;
    }
    if (ts.isVariableDeclaration(node)) collectVariableCopy(node);
  }

  function collectJsxText(node: ts.Node): void {
    if (ts.isJsxText(node)) add(node, node.text);
  }

  function collectJsxAttribute(node: ts.Node): void {
    if (
      !ts.isJsxAttribute(node) ||
      !ts.isIdentifier(node.name) ||
      !COPY_ATTRIBUTES.has(node.name.text) ||
      node.initializer === undefined
    )
      return;
    if (ts.isStringLiteral(node.initializer)) {
      add(node.initializer, node.initializer.text);
      return;
    }
    if (
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression !== undefined
    ) {
      addExpression(node.initializer.expression);
    }
  }

  function collectJsxExpression(node: ts.Node): void {
    if (
      ts.isJsxExpression(node) &&
      node.expression !== undefined &&
      !ts.isJsxAttribute(node.parent)
    ) {
      addExpression(node.expression);
    }
  }

  function collectCopyProperty(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      COPY_PROPERTIES.has(node.name.text)
    ) {
      addExpression(node.initializer);
    }
  }

  function collectToastArguments(node: ts.Node): void {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    const isToast =
      (ts.isIdentifier(callee) && callee.text === "toast") ||
      (ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "toast");
    if (isToast) node.arguments.forEach(addExpression);
  }

  collectDeclarations(sourceFile);
  visit(sourceFile);

  const lines = sourceText.split(/\r?\n/);
  return pieces.flatMap(({ node, text }) => {
    const rendered = text.replace(/\s+/g, " ").trim();
    if (rendered.length === 0) return [];
    const line =
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
      1;
    return [
      {
        file: filePath,
        line,
        text: rendered,
        context: lines[line - 1]?.trim() ?? rendered,
      },
    ];
  });
}

function matchesVocabulary(text: string): string[] {
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const match of ALL_MATCHES) {
    const key = `${match.kind}:${match.copy.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const escaped = match.copy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matched =
      match.kind === "exact-label"
        ? text.trim().toLocaleLowerCase() === match.copy.toLocaleLowerCase()
        : new RegExp(
            `(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`,
            "iu",
          ).test(text);
    if (matched) hits.push(match.copy);
  }
  return hits;
}

function scanSourceText(sourceText: string, filePath: string): VocabularyHit[] {
  return extractRenderedCopy(sourceText, filePath).flatMap((literal) =>
    matchesVocabulary(literal.text).map((copy) => ({ ...literal, copy })),
  );
}

function hasExactAllowance(copy: CopyLiteral): boolean {
  return ALLOWED_COPY.some(
    (allowance) =>
      allowance.file === copy.file && allowance.texts.includes(copy.text),
  );
}

function scanSources(): {
  readonly files: string[];
  readonly copy: CopyLiteral[];
  readonly hits: VocabularyHit[];
} {
  const files = [
    "components/settings",
    "components/hosts",
    "components/sandboxes",
    "components/layout",
    "components/chat/composer",
    "lib/sandboxes",
    "components/epic-canvas/sidebar",
  ].flatMap((directory) =>
    readdirSync(join(SOURCE_ROOT, directory), {
      withFileTypes: true,
      recursive: true,
    })
      .filter(
        (entry) =>
          entry.isFile() &&
          /\.tsx?$/.test(entry.name) &&
          !/\.test\.tsx?$/.test(entry.name) &&
          !/(?:\.fixture|-fixtures?)\.tsx?$/.test(entry.name) &&
          !/(?:^|[/\\])fixtures?(?:[/\\]|$)/.test(
            join(entry.parentPath, entry.name),
          ) &&
          !/[/\\](?:__tests__|testing)(?:[/\\]|$)/.test(
            join(entry.parentPath, entry.name),
          ),
      )
      .map((entry) => join(entry.parentPath, entry.name)),
  );
  const copy = files.flatMap((file) =>
    extractRenderedCopy(readFileSync(file, "utf8"), relative(ROOT, file)),
  );
  const hits = copy.flatMap((literal) =>
    hasExactAllowance(literal)
      ? []
      : matchesVocabulary(literal.text).map((copyMatch) => ({
          ...literal,
          copy: copyMatch,
        })),
  );
  return { files, copy, hits };
}

describe("retired environment vocabulary", () => {
  it("scans nested JSX and helper copy while skipping technical and allowed wording", () => {
    const sample = `
      import { value } from "Resting";
      const route = "terminal not running";
      const ignoredText = "pod";
      const getTone = () => ({ label: "Starting up" });
      const sandboxTone = getTone();
      const reusableCopy = "Personal host";
      const name = "work computer";
      const idlePolicy = "Destroyed after resting";
      const StatusToneBadge = ({ tone }: { tone: { label: string } }) => <span>{tone.label}</span>;
      const Sample = ({ flag, items }: { flag: boolean; items: string[] }) => (
        <>
          <div className="dormant" data-testid="Local">
            <a href={route}>{reusableCopy}</a>
            <StatusToneBadge tone={sandboxTone} />
            {flag && <span>inactive</span>}
            {flag ? <><span>Frozen</span></> : null}
            {items.map((item) => <span>workspace folders</span>)}
            <span>{\`\${name} is a Sandbox host\`}</span>
          </div>
          <p>{\`Policy: \${idlePolicy}\`}</p>
          <p>rests</p>
          <p>rested</p>
          <h2>Teams</h2>
          <p>This computer</p>
          <p>This computer only connects from its own network.</p>
          <p>The sandbox is unfrozen for now.</p>
          <p>Sign in from another device or browser.</p>
          <p>Local firewall and each machine's own network.</p>
          <p>Sessions from before individual tracking.</p>
        </>
      );
      export const standaloneCopy = "dormant";
      function standaloneLabel(): string {
        return \`Resting\`;
      }
      const validation = { problem: "Resting" };
    `;
    const hits = scanSourceText(sample, "sample.tsx");
    expect(hits.map((hit) => hit.copy)).toEqual([
      "Starting up",
      "Personal host",
      "inactive",
      "Frozen",
      "workspace folders",
      "Sandbox host",
      "Resting",
      "rests",
      "rested",
      "This computer",
      "dormant",
      "Resting",
      "Resting",
    ]);
    expect(
      hasExactAllowance({
        file: "components/settings/panels/worktree-auto-cleanup-chip.tsx",
        line: 1,
        text: "Inactive for",
        context: "Inactive for",
      }),
    ).toBe(true);
    expect(
      hasExactAllowance({
        file: "components/settings/panels/worktree-auto-cleanup-chip.tsx",
        line: 1,
        text: "Inactive for these terminals",
        context: "Inactive for these terminals",
      }),
    ).toBe(false);
    expect(
      hasExactAllowance({
        file: "components/chat/composer/other.tsx",
        line: 1,
        text: "Inactive for",
        context: "Inactive for",
      }),
    ).toBe(false);
  });

  it("finds no retired person-facing copy in host chooser and sandbox surfaces", () => {
    const result = scanSources();
    expect(
      result.files.length,
      "source directories must yield component files",
    ).toBeGreaterThan(0);
    expect(
      result.copy.length,
      "the AST scan must extract person-facing copy",
    ).toBeGreaterThan(0);
    expect(
      result.hits.map(
        (hit) =>
          `${hit.file}:${hit.line} ${JSON.stringify(hit.text)} [${hit.copy}] — ${hit.context}`,
      ),
    ).toEqual([]);
  });
});
