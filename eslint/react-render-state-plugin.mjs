const functionTypes = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

function enclosingFunction(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (functionTypes.has(parent.type)) return parent;
  }
  return null;
}

function functionName(node) {
  if (node.id?.name) return node.id.name;
  let owner = node;
  while (
    owner.parent.type === "CallExpression" &&
    ["memo", "forwardRef"].includes(callName(owner.parent))
  )
    owner = owner.parent;
  if (owner.parent.type === "ExportDefaultDeclaration")
    return "DefaultComponent";
  return owner.parent.type === "VariableDeclarator"
    ? owner.parent.id.name
    : null;
}

function callName(node) {
  return node.callee.type === "Identifier"
    ? node.callee.name
    : node.callee.property?.name;
}

function hasJustification(source, node, marker) {
  return [
    ...source.getCommentsBefore(node),
    ...source.getCommentsAfter(node),
  ].some((comment) => {
    const adjacent =
      comment.loc.end.line === node.loc.start.line - 1 ||
      comment.loc.start.line === node.loc.end.line;
    const reason = comment.value.match(
      new RegExp(`${marker}:\\s*(\\S[^\\n]*)`),
    )?.[1];
    return (
      adjacent &&
      reason &&
      (marker !== "render-cache" ||
        (/immutable/i.test(reason) && /pure/i.test(reason)) ||
        (/stable per-key instance/i.test(reason) &&
          /state read via subscription/i.test(reason)))
    );
  });
}

function resolveVariable(source, node) {
  for (let scope = source.getScope(node); scope; scope = scope.upper) {
    const variable = scope.set.get(node.name);
    if (variable) return variable;
  }
  return null;
}

function declaredFunction(variable) {
  const definition = variable?.defs[0]?.node;
  if (!definition) return null;
  if (functionTypes.has(definition.type)) return definition;
  if (functionTypes.has(definition.init?.type)) return definition.init;
  const init = definition.init;
  return init?.type === "CallExpression" &&
    callName(init) === "useCallback" &&
    functionTypes.has(init.arguments[0]?.type)
    ? init.arguments[0]
    : null;
}

const synchronousCallbacks = new Set([
  "useMemo",
  "map",
  "flatMap",
  "filter",
  "find",
  "findIndex",
  "some",
  "every",
  "reduce",
  "reduceRight",
  "forEach",
  "sort",
  "toSorted",
  "from",
]);

const noRenderCacheRead = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      cache:
        "Render reads a module-level Map/WeakMap. Publish a stable snapshot through a subscribed store instead.",
    },
  },
  create(context) {
    const source = context.sourceCode;
    const functions = new Set();
    const calls = [];
    const reads = [];
    return {
      ":function": (node) => functions.add(node),
      CallExpression: (node) => calls.push(node),
      Identifier(node) {
        const variable = resolveVariable(source, node);
        const definition = variable?.defs[0]?.node;
        if (
          variable?.scope.type !== "module" ||
          definition?.type !== "VariableDeclarator" ||
          definition.init?.type !== "NewExpression" ||
          !["Map", "WeakMap"].includes(definition.init.callee.name) ||
          !variable.references.some(
            (ref) => ref.identifier === node && ref.isRead(),
          ) ||
          hasJustification(source, definition.parent, "render-cache")
        )
          return;
        const parent = node.parent;
        if (parent.type === "MemberExpression" && parent.object === node) {
          const member = parent.computed
            ? parent.property.value
            : parent.property.name;
          if (["set", "delete", "clear"].includes(member)) return;
        } else if (
          !(
            parent.type === "SpreadElement" ||
            (parent.type === "ForOfStatement" && parent.right === node) ||
            (parent.type === "CallExpression" &&
              callName(parent) === "from" &&
              parent.callee.object?.name === "Array" &&
              parent.arguments[0] === node) ||
            (parent.type === "NewExpression" &&
              ["Map", "Set"].includes(parent.callee.name) &&
              parent.arguments[0] === node)
          )
        )
          return;
        reads.push(node);
      },
      "Program:exit"() {
        const render = new Set(
          [...functions].filter((fn) =>
            /^(?:[A-Z]|use[A-Z])/.test(functionName(fn) ?? ""),
          ),
        );
        const edges = [];
        for (const call of calls) {
          const owner = enclosingFunction(call);
          if (!owner) continue;
          const callee = call.callee;
          if (callee.type === "Identifier") {
            const target = declaredFunction(resolveVariable(source, callee));
            if (target) edges.push([owner, target]);
          } else if (functionTypes.has(callee.type)) {
            edges.push([owner, callee]);
          }
          const name = callName(call);
          if (!synchronousCallbacks.has(name)) continue;
          for (const argument of call.arguments) {
            const target = functionTypes.has(argument.type)
              ? argument
              : argument.type === "Identifier"
                ? declaredFunction(resolveVariable(source, argument))
                : null;
            if (target) edges.push([owner, target]);
          }
        }
        // Follow local helpers too, so moving cache.get() behind a function
        // does not hide a render-time read. Imported helpers need code review.
        let changed = true;
        while (changed) {
          changed = false;
          for (const [owner, target] of edges) {
            if (render.has(owner) && !render.has(target)) {
              render.add(target);
              changed = true;
            }
          }
        }
        for (const node of reads) {
          if (render.has(enclosingFunction(node))) {
            context.report({ node, messageId: "cache" });
          }
        }
      },
    };
  },
};

const noUnexplainedUseNoMemo = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      reason:
        'Explain "use no memo" with an adjacent "use-no-memo: <reason>" comment.',
    },
  },
  create(context) {
    return {
      ExpressionStatement(node) {
        if (node.directive !== "use no memo") return;
        if (!hasJustification(context.sourceCode, node, "use-no-memo")) {
          context.report({ node, messageId: "reason" });
        }
      },
    };
  },
};

export default {
  rules: {
    "no-render-cache-read": noRenderCacheRead,
    "no-unexplained-use-no-memo": noUnexplainedUseNoMemo,
  },
};
