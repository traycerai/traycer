import type { Plugin } from "vite";

// NEVER MERGE: probe the exact e384 browser failure without changing scheduling.
// Transform copies during bundling; never mutate Bun's shared dependency cache.
export function canvasBackDiagnostics(): Plugin {
  return {
    name: "traycer:canvas-back-diagnostics",
    enforce: "pre",
    transform(source, id) {
      const replace = (needle: string, diagnostic: string): string => {
        if (!source.includes(needle)) {
          throw new Error(`Canvas diagnostic seam missing in ${id}`);
        }
        console.warn(`[DEBUG-canvasback-build] ${id}`);
        return source.replace(needle, `${diagnostic}\n${needle}`);
      };
      if (/\/@xyflow\/react\/dist\/esm\/index\.(mjs|js)$/.test(id)) {
        return replace(
          "syncViewport?.(viewport);",
          `console.warn("[DEBUG-canvasback]", JSON.stringify({kind:"viewport-effect", at:performance.now(), viewport, transform:store.getState().transform}));`,
        );
      }
      if (/\/@xyflow\/system\/dist\/esm\/index\.(mjs|js)$/.test(id)) {
        return replace(
          "d3ZoomInstance?.transform(d3Selection, nextTransform, null, { sync: true });",
          `console.warn("[DEBUG-canvasback]", JSON.stringify({kind:"sync-mismatch", at:performance.now(), viewport, currentTransform, transitions:Object.entries(d3Selection.node().__transition ?? {}).map(([id,t])=>({id,state:t.state,name:t.name})), stack:new Error().stack}));`,
        );
      }
      if (id.endsWith("/d3-transition/src/interrupt.js")) {
        return replace(
          'schedule.on.call(active ? "interrupt" : "cancel", node, node.__data__, schedule.index, schedule.group);',
          `console.warn("[DEBUG-canvasback]", JSON.stringify({kind:"d3-explicit-interrupt", at:performance.now(), active, id:i, name, zoom:node.__zoom, stack:new Error().stack}));`,
        );
      }
      if (id.endsWith("/d3-transition/src/transition/schedule.js")) {
        const needle =
          'o.on.call("interrupt", node, node.__data__, o.index, o.group);';
        const changed = replace(
          needle,
          `console.warn("[DEBUG-canvasback]", JSON.stringify({kind:"d3-competing-interrupt", at:performance.now(), id, previousId:i, zoom:node.__zoom, stack:new Error().stack}));`,
        );
        const cancel =
          'o.on.call("cancel", node, node.__data__, o.index, o.group);';
        if (!changed.includes(cancel))
          throw new Error(`Canvas cancel seam missing in ${id}`);
        return changed.replace(
          cancel,
          `console.warn("[DEBUG-canvasback]", JSON.stringify({kind:"d3-competing-cancel", at:performance.now(), id, previousId:i, zoom:node.__zoom, stack:new Error().stack}));\n${cancel}`,
        );
      }
      return null;
    },
  };
}
