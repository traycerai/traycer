import type { KeyboardEvent, ReactNode } from "react";

/**
 * Radix menus do not open from a click in jsdom. The established passthrough
 * in `profile-dropdown.test.tsx` keeps every row in the document.
 */
export function profileDropdownMenuMock(): {
  readonly DropdownMenu: (props: {
    readonly children: ReactNode;
    readonly modal: boolean | undefined;
  }) => ReactNode;
  readonly DropdownMenuTrigger: (props: {
    readonly children: ReactNode;
  }) => ReactNode;
  readonly DropdownMenuContent: (props: {
    readonly children: ReactNode;
    readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  }) => ReactNode;
  readonly DropdownMenuItem: (props: {
    readonly children: ReactNode;
    readonly id: string | undefined;
    readonly onSelect: (() => void) | undefined;
    readonly onClick: (() => void) | undefined;
    readonly onKeyDown:
      | ((event: KeyboardEvent<HTMLButtonElement>) => void)
      | undefined;
    readonly "aria-label": string | undefined;
    readonly "aria-disabled": boolean | undefined;
    readonly "aria-current": "true" | undefined;
    readonly className: string | undefined;
    readonly disabled: boolean | undefined;
    readonly tabIndex: number | undefined;
    readonly title: string | undefined;
  }) => ReactNode;
  readonly DropdownMenuSeparator: () => ReactNode;
  readonly DropdownMenuShortcut: (props: {
    readonly children: ReactNode;
    readonly "data-testid": string | undefined;
  }) => ReactNode;
} {
  const passthrough = (props: { readonly children: ReactNode }): ReactNode =>
    props.children;
  return {
    DropdownMenu: (props) => (
      <div data-testid="profile-dropdown-root" data-modal={String(props.modal)}>
        {props.children}
      </div>
    ),
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: (props) => (
      <div
        role="menu"
        tabIndex={-1}
        data-testid="profile-dropdown-content"
        onKeyDown={props.onKeyDown}
      >
        {props.children}
      </div>
    ),
    DropdownMenuItem: (props) => (
      <button
        type="button"
        role="menuitem"
        id={props.id}
        aria-label={props["aria-label"]}
        aria-disabled={props["aria-disabled"]}
        aria-current={props["aria-current"]}
        className={props.className}
        disabled={props.disabled}
        tabIndex={props.tabIndex}
        title={props.title}
        onClick={props.onClick ?? props.onSelect}
      >
        {props.children}
      </button>
    ),
    DropdownMenuSeparator: () => <div role="separator" />,
    DropdownMenuShortcut: (props) => (
      <span data-testid={props["data-testid"]}>{props.children}</span>
    ),
  };
}
