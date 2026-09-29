import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const retired = /^(?:@radix-ui\/|(?:radix-ui|vaul|cmdk)(?:$|\/|@))/;
const legacy =
  /--radix-|data-(?:\[state|state)\s*=\s*["']?(?:open|closed|active|inactive|checked|unchecked)(?=["'\]\s])/;

// Unknown values inside a state selector must not turn a failed proof into a pass.
const unknownText = "\u0001";
function stringValues(node) {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isParenthesizedExpression(node)) return stringValues(node.expression);
  if (ts.isConditionalExpression(node))
    return [...stringValues(node.whenTrue), ...stringValues(node.whenFalse)];
  function combine(left, right) {
    return left.flatMap((a) => right.map((b) => a + b));
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  )
    return combine(stringValues(node.left), stringValues(node.right));
  if (ts.isTemplateExpression(node)) {
    let values = [node.head.text];
    for (const span of node.templateSpans)
      values = combine(values, stringValues(span.expression)).map(
        (value) => value + span.literal.text,
      );
    return values;
  }
  return [unknownText];
}
function legacySelector(text) {
  if (legacy.test(text)) return true;
  return [
    ...text.matchAll(/data-(?:\[state|state)\s*=\s*["']?([^\]"'\s]*)/g),
  ].some((match) => match[1].includes(unknownText));
}

export function scanPackageJson(json) {
  const findings = [];
  function visit(value, path) {
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (
        retired.test(key) ||
        /(?:^|\/|>)(?:@radix-ui\/|(?:radix-ui|vaul|cmdk)(?:$|\/|@))/.test(
          key,
        ) ||
        (typeof child === "string" && retired.test(child.replace(/^npm:/, "")))
      ) {
        findings.push(`${path}.${key}: retired UI dependency`);
      }
      visit(child, `${path}.${key}`);
    }
  }
  for (const section of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
    "catalog",
    "catalogs",
    "overrides",
    "resolutions",
  ]) {
    visit(json[section], section);
  }
  return findings;
}

export function scanSource(source, file) {
  const findings = [];
  const report = (position, message) =>
    findings.push(
      `${file}:${source.slice(0, position).split("\n").length}: ${message}`,
    );
  if (file.endsWith(".css")) {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
      comment.replace(/[^\n]/g, " "),
    );
    for (const match of code.matchAll(
      /@import\s+(?:url\(\s*)?["']?([^"'\s;)]+)/g,
    )) {
      if (retired.test(match[1])) report(match.index, "retired UI import");
    }
    for (const match of code.matchAll(new RegExp(legacy.source, "g")))
      report(match.index, "legacy UI selector or variable");
    return findings;
  }
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const menuItems = new Set();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const specifier of bindings.elements) {
        if (
          /(?:Menu|Menubar)(?:Checkbox|Radio)?Item$/.test(
            (specifier.propertyName ?? specifier.name).text,
          )
        )
          menuItems.add(specifier.name.text);
      }
    }
  }
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      retired.test(node.moduleSpecifier.text)
    )
      report(node.getStart(), "retired UI import");
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(ast) === "require") &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      retired.test(node.arguments[0].text)
    )
      report(node.getStart(), "retired UI import");
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      retired.test(node.moduleReference.expression.text)
    )
      report(node.getStart(), "retired UI import");
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal) &&
      retired.test(node.argument.literal.text)
    )
      report(node.getStart(), "retired UI import");
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(ast);
      const tag = node.parent.parent.tagName.getText(ast);
      if (
        name === "asChild" ||
        (name === "onSelect" &&
          (menuItems.has(tag) ||
            /(?:Menu|Menubar)(?:Checkbox|Radio)?Item$|(?:Menu|Menubar)\.(?:Checkbox|Radio)?Item$/.test(
              tag,
            )))
      )
        report(node.getStart(), `legacy ${name} prop`);
    }
    if (
      (ts.isStringLiteralLike(node) ||
        ts.isTemplateExpression(node) ||
        (ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.PlusToken)) &&
      stringValues(node).some(legacySelector)
    )
      report(node.getStart(), "legacy or unresolved UI selector or variable");
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return findings;
}

export function checkUiMigration() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const files = [
    ...new Set(
      execFileSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { cwd: root, encoding: "utf8" },
      )
        .split("\0")
        .filter(Boolean),
    ),
  ];
  const findings = [];
  let sources = 0;
  let packages = 0;
  for (const file of files) {
    const absolute = resolve(root, file);
    if (!existsSync(absolute)) continue;
    if (file === "package.json" || file.endsWith("/package.json")) {
      packages++;
      findings.push(
        ...scanPackageJson(JSON.parse(readFileSync(absolute, "utf8"))).map(
          (finding) => `${file}: ${finding}`,
        ),
      );
    } else if (file.includes("/src/") && /\.(?:[cm]?[jt]sx?|css)$/.test(file)) {
      sources++;
      findings.push(...scanSource(readFileSync(absolute, "utf8"), file));
    }
  }
  if (findings.length) throw new Error(findings.join("\n"));
  console.log(
    `[ui-migration] ${sources} source files, ${packages} manifests: no retired imports, dependencies or legacy APIs. Comments and license prose excluded; no code allowlist.`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  checkUiMigration();
