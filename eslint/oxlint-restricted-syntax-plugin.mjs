const noRestrictedSyntax = {
  meta: {
    type: "suggestion",
    schema: {
      type: "array",
      items: {
        oneOf: [
          { type: "string" },
          {
            type: "object",
            properties: {
              selector: { type: "string" },
              message: { type: "string" },
            },
            required: ["selector"],
            additionalProperties: false,
          },
        ],
      },
      uniqueItems: true,
      minItems: 0,
    },
    messages: {
      restrictedSyntax: "{{message}}",
    },
  },
  create(context) {
    return Object.fromEntries(
      context.options.map((selectorOrObject) => {
        const isString = typeof selectorOrObject === "string";
        const selector = isString
          ? selectorOrObject
          : selectorOrObject.selector;
        const message =
          !isString && selectorOrObject.message
            ? selectorOrObject.message
            : `Using '${selector}' is not allowed.`;

        return [
          selector,
          (node) => {
            context.report({
              node,
              messageId: "restrictedSyntax",
              data: { message },
            });
          },
        ];
      }),
    );
  },
};

export default {
  meta: { name: "traycer" },
  rules: { "no-restricted-syntax": noRestrictedSyntax },
};
