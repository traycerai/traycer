import { Fragment, type ReactNode } from "react";

/**
 * `text` for a box that ends it in an ellipsis (`truncate`), with no space
 * left before the ellipsis. Chrome cuts at the last character that fits, so a
 * cut just after a space reads "React …". Here each space is a no-break space
 * held in one box with the first letter of the word it opens, so the two go
 * together and the ellipsis follows the word before. Everything else truncates
 * as before, letter by letter; the space keeps the font's own width.
 */
export function TrimmedEllipsis(props: { readonly text: string }): ReactNode {
  const [first = "", ...rest] = props.text.trim().split(/\s+/);
  return (
    <>
      {first}
      {rest.map((word, index) => {
        const [head = "", ...tail] = Array.from(word);
        return (
          <Fragment key={`${String(index)}:${word}`}>
            <span className="inline-block">{` ${head}`}</span>
            {tail.join("")}
          </Fragment>
        );
      })}
    </>
  );
}
