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

// This rule follows bindings within the linted file. Helpers outside the test globs require review.
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
    const reads = (variable) =>
      variable.references
        .filter((reference) => reference.isRead())
        .map((reference) => reference.identifier);
    const referencesOf = (node) =>
      source.getDeclaredVariables(node).flatMap(reads);
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
      } else if (
        parent.type === "AssignmentExpression" &&
        parent.operator === "=" &&
        parent.right === node &&
        parent.left.type === "Identifier"
      ) {
        const binding = source
          .getScope(parent)
          .references.find(
            (reference) => reference.identifier === parent.left,
          )?.resolved;
        if (binding) for (const use of reads(binding)) checkStoreReference(use);
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
              if (
                member.type === "VariableDeclarator" &&
                member.init === use &&
                member.id.type === "ObjectPattern"
              ) {
                for (const property of member.id.properties) {
                  if (property.type !== "Property") continue;
                  const name = propertyName(property.key, property.computed);
                  if (isAdapter && controllerInputs.has(name)) report(property);
                  if (isStore && name === "useSelectionAuthorityStore") {
                    const identifier =
                      property.value.type === "AssignmentPattern"
                        ? property.value.left
                        : property.value;
                    const binding = source
                      .getDeclaredVariables(member)
                      .find((variable) =>
                        variable.identifiers.includes(identifier),
                      );
                    if (binding)
                      for (const read of reads(binding))
                        checkStoreReference(read);
                  }
                }
                continue;
              }
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
      ImportExpression(node) {
        if (storeModule.test(propertyName(node.source, true))) report(node);
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
