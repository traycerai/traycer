/** Radix's DropdownMenu opens on pointerdown rather than click, which jsdom tests fight; this renders every
 * menu inline and always-open so a row can be selected directly. */
import type { ReactNode } from "react";

// Declarations rather than `const x = passthrough` aliases: the react-refresh lint rule can only recognize a
// function declaration as a component, and an aliased const export trips it.
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

/** A stand-in claiming `menuitemradio` would owe an `aria-checked` it cannot know - the group's value never
 * reaches the item here - so a test could assert against a checked state this file invented. */
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
