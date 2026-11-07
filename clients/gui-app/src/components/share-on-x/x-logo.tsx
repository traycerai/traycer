import type { ReactNode } from "react";

/** X's mark, drawn in the current text colour. */
export function XLogo(props: { readonly className: string }): ReactNode {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={props.className}
    >
      <path d="M18.9 2H22l-7.3 8.3L23 22h-6.6l-5.1-6.7L5.4 22H2.3l7.8-8.9L1.5 2h6.7l4.6 6.1L18.9 2Zm-1.1 18h1.7L7.2 3.9H5.4L17.8 20Z" />
    </svg>
  );
}
