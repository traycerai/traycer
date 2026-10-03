/// <reference types="node" />

import { ESLint, Linter } from "eslint";
import path from "node:path";
import { pathToFileURL } from "node:url";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

/**
 * The plugin's contract is what it reports on real source, so every case runs
 * the shipped rules through ESLint's own `Linter` over a TSX fixture and reads
 * the rule ids back. Nothing here reaches into a rule's selectors or visitor.
 */

const PLUGIN = "react-render-state";
const CACHE_RULE = `${PLUGIN}/no-render-cache-read`;
const MEMO_RULE = `${PLUGIN}/no-unexplained-use-no-memo`;

function isPlugin(value: unknown): value is ESLint.Plugin {
  return (
    typeof value === "object" &&
    value !== null &&
    "rules" in value &&
    typeof value.rules === "object" &&
    value.rules !== null
  );
}

const imported: unknown = await import(
  pathToFileURL(
    path.resolve(process.cwd(), "../../eslint/react-render-state-plugin.mjs"),
  ).href
);
function readPlugin(value: unknown): ESLint.Plugin {
  if (
    typeof value === "object" &&
    value !== null &&
    "default" in value &&
    isPlugin(value.default)
  ) {
    return value.default;
  }
  throw new Error("Expected a default-exported ESLint plugin");
}
const plugin = readPlugin(imported);

function lint(code: string, ruleId: string): readonly Linter.LintMessage[] {
  const linter = new Linter({ configType: "flat" });
  const messages = linter.verify(
    code,
    [
      {
        files: ["**/*.tsx"],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        plugins: { [PLUGIN]: plugin },
        rules: { [ruleId]: "error" },
      },
    ],
    { filename: "src/components/probe.tsx" },
  );
  // A fixture that does not parse would make every "valid" case pass vacuously.
  const fatal = messages.filter((message) => message.fatal === true);
  expect(fatal).toEqual([]);
  return messages.filter((message) => message.ruleId === ruleId);
}

describe("react-render-state/no-render-cache-read", () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    [
      "Map.get in a component body",
      `const cache = new Map<string, number>();
       export function Row(props: { id: string }) {
         const value = cache.get(props.id);
         return <span>{value}</span>;
       }`,
    ],
    [
      "WeakMap.has in a component body",
      `const seen = new WeakMap<object, boolean>();
       export function Row(props: { node: object }) {
         return <span>{String(seen.has(props.node))}</span>;
       }`,
    ],
    [
      "Map.size in a component body",
      `const cache = new Map<string, number>();
       export function Count() {
         return <span>{cache.size}</span>;
       }`,
    ],
    [
      "a read in a custom hook body",
      `const cache = new Map<string, number>();
       export function useCached(id: string) {
         return cache.get(id);
       }`,
    ],
    [
      "a read inside a render-time useMemo callback",
      `import { useMemo } from "react";
       const cache = new Map<string, number>();
       export function Row(props: { id: string }) {
         const value = useMemo(() => cache.get(props.id), [props.id]);
         return <span>{value}</span>;
       }`,
    ],
    [
      "a read inside a render-time IIFE",
      `const cache = new Map<string, number>();
       export function Row(props: { id: string }) {
         const value = (() => cache.get(props.id))();
         return <span>{value}</span>;
       }`,
    ],
    [
      "an anonymous function component wrapped in memo",
      `import { memo } from "react";
       const cache = new Map<string, number>();
       export const Row = memo(function (props: { id: string }) {
         return <span>{cache.get(props.id)}</span>;
       });`,
    ],
    [
      "an anonymous arrow component wrapped in React.memo",
      `import React from "react";
       const cache = new Map<string, number>();
       export const Row = React.memo((props: { id: string }) => (
         <span>{cache.get(props.id)}</span>
       ));`,
    ],
    [
      "an anonymous forwardRef component",
      `import { forwardRef } from "react";
       const cache = new Map<string, number>();
       export const Row = forwardRef<HTMLSpanElement, { id: string }>(
         (props, ref) => <span ref={ref}>{cache.get(props.id)}</span>,
       );`,
    ],
    [
      "an anonymous component wrapped in memo(forwardRef(...))",
      `import { forwardRef, memo } from "react";
       const cache = new Map<string, number>();
       export const Row = memo(
         forwardRef<HTMLSpanElement, { id: string }>((props, ref) => (
           <span ref={ref}>{cache.get(props.id)}</span>
         )),
       );`,
    ],
    [
      "spreading a module Map in a component body",
      `const cache = new Map<string, number>();
       export function List() {
         return <>{[...cache].map(([id]) => <b key={id} />)}</>;
       }`,
    ],
    [
      "Array.from over a module Map in a component body",
      `const cache = new Map<string, number>();
       export function List() {
         return <>{Array.from(cache).map(([id]) => <b key={id} />)}</>;
       }`,
    ],
    [
      "a render-cache marker with an empty reason",
      `// render-cache:
       const cache = new Map<string, number>();
       export function Row(props: { id: string }) {
         return <span>{cache.get(props.id)}</span>;
       }`,
    ],
    [
      "a render-cache marker whose reason is only half the immutable/pure claim",
      `// render-cache: immutable key
       const cache = new Map<string, number>();
       export function Row(props: { id: string }) {
         return <span>{cache.get(props.id)}</span>;
       }`,
    ],
    [
      "a lifecycle render-cache marker with an empty reason",
      `// render-cache:
       const instances = new Map<string, { size: number }>();
       export function Row(props: { id: string }) {
         return <span>{instances.get(props.id)?.size}</span>;
       }`,
    ],
    [
      "a lifecycle render-cache marker that omits the subscription half",
      `// render-cache: stable per-key instance
       const instances = new Map<string, { size: number }>();
       export function Row(props: { id: string }) {
         return <span>{instances.get(props.id)?.size}</span>;
       }`,
    ],
    [
      "a lifecycle render-cache marker that omits the stable-instance half",
      `// render-cache: state read via subscription
       const instances = new Map<string, { size: number }>();
       export function Row(props: { id: string }) {
         return <span>{instances.get(props.id)?.size}</span>;
       }`,
    ],
    [
      "a render-cache marker that is not adjacent to the declaration",
      `// render-cache: immutable key; value is a pure function of that key

       const cache = new Map<string, number>();
       export function Row(props: { id: string }) {
         return <span>{cache.get(props.id)}</span>;
       }`,
    ],
    [
      "an anonymous default-exported component",
      `const cache = new Map<string, number>();
       export default function () {
         return <span>{cache.get("x")}</span>;
       }`,
    ],
    [
      "a useCallback-wrapped read that render then calls",
      `import { useCallback } from "react";
       const cache = new Map<string, number>();
       export function Row() {
         const read = useCallback(() => cache.get("x"), []);
         return <span>{read()}</span>;
       }`,
    ],
    [
      "a non-component helper CALLED during render",
      `const cache = new Map<string, number>();
       function readCached(id: string) {
         return cache.get(id);
       }
       export function Row(props: { id: string }) {
         return <span>{readCached(props.id)}</span>;
       }`,
    ],
    [
      "a read behind two hops of local helpers called during render",
      `const cache = new Map<string, number>();
       const inner = (id: string) => cache.has(id);
       function outer(id: string) {
         return inner(id);
       }
       export function Row(props: { id: string }) {
         return <span>{String(outer(props.id))}</span>;
       }`,
    ],
    [
      "a read inside a callback that render executes (Array.map)",
      `const cache = new Map<string, number>();
       export function List(props: { ids: readonly string[] }) {
         return <>{props.ids.map((id) => <b key={id}>{cache.get(id)}</b>)}</>;
       }`,
    ],
  ];

  it.each(rejected)("rejects %s", (_name, code) => {
    expect(lint(code, CACHE_RULE)).not.toHaveLength(0);
  });

  it("reports each render read separately", () => {
    const messages = lint(
      `const cache = new Map<string, number>();
       export function Row(props: { id: string }) {
         return <span>{cache.get(props.id)}{String(cache.has(props.id))}</span>;
       }`,
      CACHE_RULE,
    );
    expect(messages).toHaveLength(2);
  });

  const allowed: ReadonlyArray<readonly [string, string]> = [
    [
      "a local Map that shadows the module one",
      `const cache = new Map<string, number>();
       export function Row(props: { id: string }) {
         const cache = new Map<string, number>();
         return <span>{cache.get(props.id)}</span>;
       }`,
    ],
    [
      "a parameter that shadows the module Map",
      `const cache = new Map<string, number>();
       export function Row(props: { cache: Map<string, number>; id: string }) {
         const read = (cache: Map<string, number>) => cache.get(props.id);
         return <span>{read(props.cache)}</span>;
       }`,
    ],
    [
      "a read inside useEffect",
      `import { useEffect } from "react";
       const cache = new Map<string, number>();
       export function Row(props: { id: string }) {
         useEffect(() => {
           void cache.get(props.id);
         }, [props.id]);
         return null;
       }`,
    ],
    [
      "a read inside useLayoutEffect",
      `import { useLayoutEffect } from "react";
       const cache = new WeakMap<object, number>();
       export function Row(props: { node: object }) {
         useLayoutEffect(() => {
           void cache.has(props.node);
         }, [props.node]);
         return null;
       }`,
    ],
    [
      "a read inside a JSX event handler",
      `const cache = new Map<string, number>();
       export function Row(props: { id: string }) {
         return <button onClick={() => console.log(cache.get(props.id))} />;
       }`,
    ],
    [
      "a read inside a handler declared in render but only called later",
      `const cache = new Map<string, number>();
       export function Row(props: { id: string }) {
         const onClick = () => cache.size + (cache.get(props.id) ?? 0);
         return <button onClick={onClick} />;
       }`,
    ],
    [
      "a read inside a useSyncExternalStore snapshot callback",
      `import { useSyncExternalStore } from "react";
       const cache = new Map<string, number>();
       const subscribe = (notify: () => void) => () => notify();
       export function Row(props: { id: string }) {
         const value = useSyncExternalStore(subscribe, () => cache.get(props.id));
         return <span>{value}</span>;
       }`,
    ],
    [
      "reads of a cache declared with an adjacent render-cache reason",
      `// render-cache: immutable key; value is a pure function of that key
       const cache = new Map<string, number>();
       export function Row(props: { id: string }) {
         return <span>{cache.get(props.id)}</span>;
       }`,
    ],
    [
      "spreading and Array.from over a cache declared with a render-cache reason",
      `import { memo } from "react";
       // render-cache: immutable key; value is a pure function of that key
       const cache = new Map<string, number>();
       export const List = memo(function () {
         return <>{[...cache].length}{Array.from(cache).length}</>;
       });`,
    ],
    [
      "reads of a cache declared with the lifecycle render-cache annotation",
      `// render-cache: stable per-key instance; state read via subscription
       const instances = new Map<string, { size: number }>();
       export function Row(props: { id: string }) {
         return <span>{instances.get(props.id)?.size}</span>;
       }`,
    ],
    [
      "an empty module Map used only as a props or fallback value",
      `const EMPTY_MAP: ReadonlyMap<string, number> = new Map();
       function Child(props: { values: ReadonlyMap<string, number> }) {
         return <span>{props.values.get("a")}</span>;
       }
       export function Row(props: { values: ReadonlyMap<string, number> | null }) {
         const values = props.values ?? EMPTY_MAP;
         return (
           <>
             <span>{values.get("a")}</span>
             <Child values={EMPTY_MAP} />
           </>
         );
       }`,
    ],
    [
      "spreading a module Map inside an effect",
      `import { useEffect } from "react";
       const cache = new Map<string, number>();
       export function List() {
         useEffect(() => {
           void [...cache];
           void Array.from(cache);
         }, []);
         return null;
       }`,
    ],
    [
      "a useSyncExternalStore snapshot wrapped in useCallback",
      `import { useCallback, useSyncExternalStore } from "react";
       const cache = new Map<string, number>();
       const subscribe = (notify: () => void) => () => notify();
       export function Row(props: { id: string }) {
         const value = useSyncExternalStore(
           subscribe,
           useCallback(() => cache.get(props.id), [props.id]),
         );
         return <span>{value}</span>;
       }`,
    ],
    [
      "a local helper called only from an effect",
      `import { useEffect } from "react";
       const cache = new Map<string, number>();
       function readCached(id: string) {
         return cache.get(id);
       }
       export function Row(props: { id: string }) {
         useEffect(() => {
           void readCached(props.id);
         }, [props.id]);
         return null;
       }`,
    ],
    [
      "a read in a module function that no render calls",
      `const cache = new Map<string, number>();
       export function readCached(id: string) {
         return cache.get(id);
       }`,
    ],
    [
      "get/has/size on something that is not a module Map",
      `export function Row(props: { params: URLSearchParams; ids: Set<string> }) {
         return <span>{props.params.get("a")}{String(props.ids.has("a"))}{props.ids.size}</span>;
       }`,
    ],
  ];

  it.each(allowed)("allows %s", (_name, code) => {
    expect(lint(code, CACHE_RULE)).toHaveLength(0);
  });
});

describe("react-render-state/no-unexplained-use-no-memo", () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    [
      "a bare directive",
      `export function Row() {
         "use no memo";
         return null;
       }`,
    ],
    [
      "a directive with an unrelated comment",
      `export function Row() {
         "use no memo"; // Render reads live DOM state.
         return null;
       }`,
    ],
    [
      "a directive whose marker has no reason",
      `export function Row() {
         "use no memo"; // use-no-memo:
         return null;
       }`,
    ],
    [
      "a reason separated from the directive by a blank line",
      `export function Row() {
         // use-no-memo: reads a mutable cache the compiler cannot see.

         "use no memo";
         return null;
       }`,
    ],
    [
      "a module-level directive with no comment",
      `"use no memo";
       export function Row() {
         return null;
       }`,
    ],
  ];

  it.each(rejected)("rejects %s", (_name, code) => {
    expect(lint(code, MEMO_RULE)).toHaveLength(1);
  });

  const allowed: ReadonlyArray<readonly [string, string]> = [
    [
      "a trailing use-no-memo reason",
      `export function Row() {
         "use no memo"; // use-no-memo: reads a mutable cache the compiler cannot see.
         return null;
       }`,
    ],
    [
      "a use-no-memo reason on the preceding line",
      `export function Row() {
         // use-no-memo: reads a mutable cache the compiler cannot see.
         "use no memo";
         return null;
       }`,
    ],
    [
      "a module-level directive with a reason",
      `// use-no-memo: this file measures live layout.
       "use no memo";
       export function Row() {
         return null;
       }`,
    ],
    [
      "other directives, which it does not police",
      `export function Row() {
         "use memo";
         return null;
       }`,
    ],
  ];

  it.each(allowed)("allows %s", (_name, code) => {
    expect(lint(code, MEMO_RULE)).toHaveLength(0);
  });
});
