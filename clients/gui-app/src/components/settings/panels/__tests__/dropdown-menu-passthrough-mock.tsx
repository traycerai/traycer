/**
 * Shared `@/components/ui/dropdown-menu` stand-in for the suites that mount the
 * Providers settings panel.
 *
 * Radix's DropdownMenu opens on pointerdown rather than click, which jsdom
 * tests fight; this renders every menu inline and always-open so a row can be
 * selected directly. It lives here rather than being hand-copied into each
 * suite because it is an EXPORT LIST: a component adding one more dropdown
 * primitive breaks every partial copy that renders it, and each copy fails at
 * a different point in the shard matrix. One list, one place to extend.
 *
 * Wire it up by SPREADING the namespace into a plain object:
 *
 * ```ts
 * vi.mock("@/components/ui/dropdown-menu", async () => ({
 *   ...(await import("./dropdown-menu-passthrough-mock")),
 * }));
 * ```
 *
 * Returning the namespace directly (`() => import("...")`) does NOT work and
 * fails silently: a module namespace is frozen, so vitest cannot attach its
 * mock metadata to it. The dropdown itself still renders passthrough, but the
 * file's OTHER `vi.mock` factories stop taking effect - which surfaces as
 * unrelated assertions failing deep in the suite, never as a mocking error.
 */
import type { ReactNode } from "react";

// Declarations rather than `const x = passthrough` aliases: the react-refresh
// lint rule can only recognize a function declaration as a component, and an
// aliased const export trips it.
export function DropdownMenu(props: {
  readonly children: ReactNode;
}): ReactNode {
  return props.children;
}

export function DropdownMenuTrigger(props: {
  readonly children: ReactNode;
}): ReactNode {
  return props.children;
}

export function DropdownMenuContent(props: {
  readonly children: ReactNode;
}): ReactNode {
  return props.children;
}

export function DropdownMenuItem(props: {
  readonly children: ReactNode;
  readonly onSelect: (() => void) | undefined;
  readonly "aria-label": string | undefined;
  readonly "aria-current": "true" | undefined;
  readonly className: string | undefined;
  readonly disabled: boolean | undefined;
  readonly title: string | undefined;
}): ReactNode {
  return (
    <button
      type="button"
      role="menuitem"
      aria-label={props["aria-label"]}
      aria-current={props["aria-current"]}
      className={props.className}
      disabled={props.disabled}
      title={props.title}
      onClick={props.onSelect}
    >
      {props.children}
    </button>
  );
}

export function DropdownMenuSeparator(): ReactNode {
  return <div role="separator" />;
}

export function DropdownMenuShortcut(props: {
  readonly children: ReactNode;
  readonly "data-testid": string | undefined;
}): ReactNode {
  return <span data-testid={props["data-testid"]}>{props.children}</span>;
}

export function DropdownMenuLabel(props: {
  readonly children: ReactNode;
}): ReactNode {
  return <div>{props.children}</div>;
}

/**
 * The radio pair is deliberately ROLE-FREE. A stand-in claiming
 * `menuitemradio` would owe an `aria-checked` it cannot know - the group's
 * value never reaches the item here - so a test could assert against a checked
 * state this file invented. Selection behaviour belongs against the real Radix
 * menu; see provider-rail-controls.test.
 */
export function DropdownMenuRadioGroup(props: {
  readonly children: ReactNode;
}): ReactNode {
  return <div>{props.children}</div>;
}

export function DropdownMenuRadioItem(props: {
  readonly children: ReactNode;
  readonly value: string;
}): ReactNode {
  return <div data-value={props.value}>{props.children}</div>;
}
