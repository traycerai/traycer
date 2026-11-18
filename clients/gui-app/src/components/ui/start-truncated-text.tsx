import type { HTMLAttributes, ReactNode, Ref } from "react";
import {
  TRUNCATE_START_INNER_STYLE,
  TRUNCATE_START_STYLE,
} from "@/lib/truncate-start-style";

interface StartTruncatedTextProps extends Omit<
  HTMLAttributes<HTMLSpanElement>,
  "children" | "className" | "dir" | "style"
> {
  readonly children: ReactNode;
  readonly className: string;
  readonly ref?: Ref<HTMLSpanElement>;
}

export function StartTruncatedText(props: StartTruncatedTextProps) {
  const { children, className, ref, ...spanProps } = props;
  return (
    <span
      {...spanProps}
      ref={ref}
      className={className}
      style={TRUNCATE_START_STYLE}
    >
      <span dir="ltr" style={TRUNCATE_START_INNER_STYLE}>
        {children}
      </span>
    </span>
  );
}
