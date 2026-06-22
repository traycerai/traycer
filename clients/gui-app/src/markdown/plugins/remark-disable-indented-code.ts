import type { Plugin } from "unified";

export const remarkDisableIndentedCode: Plugin = function () {
  const data = this.data() as { micromarkExtensions?: unknown[] };
  if (!data.micromarkExtensions) {
    data.micromarkExtensions = [];
  }
  data.micromarkExtensions.push({ disable: { null: ["codeIndented"] } });
};
