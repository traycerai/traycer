const message = "Drive selection evidence through mountTestSelectionAuthority.";
const storeModule = /(?:^|\/)selection-authority-store(?:\.ts)?$/u;
const controllerAdapter =
  /(?:^|\/)epic-session-controller-test-support(?:\.ts)?$/u;
const controllerInputs = new Set([
  "setTestEffectiveHost",
  "notifyTestSelectionSubscribers",
]);

function propertyName(node, computed) {
  if (!computed && node.type === "Identifier") return node.name;
  if (node.type === "Literal") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

export const selectionTestWrites = {
  meta: {
    type: "problem",
    schema: [],
    messages: { driveEvidence: message },
  },
  create(context) {
    const source = context.sourceCode;
    const report = (node) =>
      context.report({ node, messageId: "driveEvidence" });
    const referencesOf = (node) =>
      source
        .getDeclaredVariables(node)
        .flatMap((variable) =>
          variable.references
            .filter((reference) => reference.isRead())
            .map((reference) => reference.identifier),
        );
    const storeReferences = new WeakSet();

    function checkStoreReference(node) {
      if (storeReferences.has(node)) return;
      storeReferences.add(node);
      const parent = node.parent;
      if (parent.type === "MemberExpression" && parent.object === node) {
        if (propertyName(parent.property, parent.computed) === "setState")
          report(parent);
      } else if (parent.type === "VariableDeclarator" && parent.init === node) {
        if (parent.id.type === "Identifier") {
          for (const use of referencesOf(parent)) checkStoreReference(use);
        } else if (parent.id.type === "ObjectPattern") {
          for (const property of parent.id.properties) {
            if (
              property.type === "Property" &&
              propertyName(property.key, property.computed) === "setState"
            ) {
              report(property);
            }
          }
        }
      }
    }

    return {
      ImportDeclaration(node) {
        const isStore = storeModule.test(node.source.value);
        const isAdapter = controllerAdapter.test(node.source.value);
        if (!isStore && !isAdapter) return;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier") {
            const name = specifier.imported.name ?? specifier.imported.value;
            if (isAdapter && controllerInputs.has(name)) report(specifier);
            if (isStore && name === "useSelectionAuthorityStore") {
              for (const use of referencesOf(specifier))
                checkStoreReference(use);
            }
          } else if (specifier.type === "ImportNamespaceSpecifier") {
            for (const use of referencesOf(specifier)) {
              const member = use.parent;
              if (member.type !== "MemberExpression" || member.object !== use)
                continue;
              const name = propertyName(member.property, member.computed);
              if (isAdapter && controllerInputs.has(name)) report(member);
              if (isStore && name === "useSelectionAuthorityStore") {
                checkStoreReference(member);
              }
            }
          }
        }
      },
      MemberExpression(node) {
        if (
          propertyName(node.property, node.computed) === "applyKernelSnapshot"
        )
          report(node);
      },
      "ObjectPattern > Property"(node) {
        if (propertyName(node.key, node.computed) === "applyKernelSnapshot")
          report(node);
      },
    };
  },
};
