# @traycer/html-source

Source-preserving HTML edits shared by browser and host callers. parse5 supplies
the HTML tree and source locations; this package applies string splices and never
serializes the tree. It has no DOM, filesystem, or Node runtime dependency.

Every range is half-open and measured in **UTF-16 code units**, as with
`String.prototype.slice`. Ranges and returned elements refer to the original
input, including a leading BOM and CRLF line endings. Reparse after an edit before
reusing positions. A host must separately check that a positional request targets
the same file revision that was served; an offset and tag name alone cannot prove
that identity.

```ts
import {
  insertTid,
  setStyleDeclaration,
  stampPositions,
} from "@traycer/html-source";

const source = '<p class="greeting">Hello &amp; welcome</p>';
const served = stampPositions(source, {
  attributeName: "data-source-position",
});
// served.text: <p data-source-position="0" class="greeting">…</p>
// Serve this copy; do not persist its temporary markers.

const identified = insertTid(
  source,
  { kind: "position", startTagOffset: 0, tagName: "p" },
  "greeting",
);
if (identified.ok) {
  const edited = setStyleDeclaration(
    identified.text,
    { kind: "tid", tid: "greeting" },
    "color",
    "red",
  );
  if (edited.ok) console.log(edited.text);
}
```

| Function                                              | Result / behavior                                                                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `parseHtmlSource(text)`                               | `{children, elements}`; `elements` is a flat source-ordered index of the tree.                                       |
| `stampPositions(text, {attributeName})`               | `{text, splices}`; inserts markers after safe literal tag names; replaces authored markers on tree-visible tags.     |
| `locateElement(text, locator)`                        | `{ok: true, element}` or `{ok: false, reason}`.                                                                      |
| `insertTid(text, locator, tid)`                       | Inserts one `data-tid` immediately after the tag name; refuses an existing id.                                       |
| `setAttribute(text, locator, name, value)`            | Sets a decoded value; `null` removes the attribute and one preceding space where safe.                               |
| `setStyleDeclaration(text, locator, property, value)` | Sets one inline declaration; `null` removes every matching declaration.                                              |
| `setTextContent(text, locator, newText)`              | Replaces the inner text of an element with only text children.                                                       |
| `setTextNode(text, locator, index, newText)`          | Replaces a direct text child; zero-based index counts text children only, including whitespace.                      |
| `findLiteralText(text, locator, quote)`               | First matching source range, or `null`; matches decoded text, then normalized whitespace, across inline descendants. |
| `replaceRange(text, {start, end, replacement})`       | `{text, splices}`; low-level primitive without HTML semantics.                                                       |

An element locator is `{kind: "position", startTagOffset, tagName}` or
`{kind: "tid", tid}`. Tag names match without ASCII case distinctions. Duplicate
ids on separate literal elements are ambiguous. Nodes inserted by HTML tree
repair have `startTag: null` and cannot be edited. Formatting reconstruction can
also produce multiple elements from one authored tag. These elements have
`isUniqueSource: false`; both locator kinds refuse with `not-unique`, and serving
removes their existing position markers instead of stamping them. This includes
the original tag when its reconstructed copy has no source location. `effectiveTid`
contains the browser-effective first `data-tid`, even on a reconstructed copy.
Adding an attribute can itself trigger formatting reconstruction. Stamping
therefore reparses the served text and removes conflicting markers until the
remaining inserted markers each identify exactly one element with a unique
source range. After six unsuccessful rounds it inserts no markers. Every round
uses the original offsets and preserves splices relative to the original input.

Authored markers on ignored start-tag tokens are unsupported: for example, in
`<html><p>x<body data-pos=1>`, the ignored `body` token's marker survives on the
implied body. Only authored markers on start tags represented in the tree can be
stripped. This can make a generated element look literal in the UI; it does not
authorize an edit. The host must still verify the file revision, tag at the
requested offset, and uniqueness using the locator/edit APIs. In this example,
the body locator at offset 1 refuses. No private parse5 parser hooks are used.

Template contents appear in their element's `children`. Comments are represented explicitly so a
text replacement cannot erase one by accident. Doctypes are left in the source.
Attribute names are ASCII-lowercased; attribute and text values are decoded.
Attribute `valueRange` excludes quotes and is `null` for valueless attributes.

Every successful locator edit returns `{ok: true, text, splices, element}`.
Refusals return `{ok: false, reason}` without changing anything; exported
`EditMissReason` lists the reasons. Splices are ordered and non-overlapping, and
are all relative to the input, **not** to an intermediate edit. Invalid primitive
ranges throw `RangeError`; an invalid stamp name throws `TypeError`.

New text and attribute values must be **unescaped**, as supplied by DOM
`textContent` or `getAttribute`. Text escapes `&`, `<`, and `>`; attributes escape
`&` and the quote delimiter. Existing quotes are retained; an unquoted attribute
acquires double quotes when necessary. An unchanged attribute value is a no-op,
preserving its entity spelling.
Duplicate attributes keep HTML's first-value lookup behavior; editing a duplicated
attribute by name refuses with `duplicate-attribute`.
Attribute changes (including tid and style edits) reparse their output. The
target must remain unique, and the number of elements and multiplicity of their
source starts, adjusted for splice lengths, must remain unchanged. Source-less
formatting clones are counted against their authored origin, identified by the
shared attribute array, so changing which tag a clone came from also refuses.
If a clone's origin cannot be established, the edit refuses conservatively.
These refusals return `unsafe-context` without edited text.

Style edits preserve unrelated declarations and the winning declaration's
`!important` suffix. Standard property names compare without ASCII case
distinctions; custom properties are case-sensitive. For duplicates, the last
important declaration wins, otherwise the last declaration wins. Removing a
property removes all its occurrences so a previous value cannot reappear. The
scanner respects strings, comments, escapes, unquoted URL tokens and nested
blocks; `/*` inside an unquoted URL remains URL data. Escaped identifiers in
`!important` are recognized while their original source spelling is preserved.
Only scanned top-level semicolons terminate a declaration. Malformed input
refuses an edit. It does not validate CSS semantics: the canvas UI must validate
those using its browser CSS parser. CSS property names supplied to this API are
unescaped ASCII names (including custom properties).

Text edits refuse raw-text/RCDATA elements (including script, style, textarea,
title and noscript). Whole-content replacement also refuses void elements,
missing explicit end tags, element children and comments. Individual text edits
refuse ranges made unsafe by HTML error recovery.
Every text edit is reparsed before success; if the decoded result differs from
the requested text, it refuses with `unsafe-context`. A leading newline inserted
directly after a `pre` or `listing` start tag is doubled because HTML consumes
one. Direct text-node edits in table, tbody, thead, tfoot and tr elements refuse
non-whitespace replacements, which HTML would move outside the target.
Quote search is best effort;
its returned span can include markup between matched text descendants, and is
an anchor, **not a range to blindly replace**. It does not inspect raw-text
descendants or perform layout-dependent `innerText` matching.

`wrapTextRange(text, locator, start, end, tag, href)` and
`unwrapTextRange(text, locator, start, end, tag)` use decoded UTF-16 offsets in
the selected element's full `textContent`. A range must fit within one text
node and cannot divide an entity expansion or a surrogate pair. Wrapping
supports `b`, `i`, `u`, and `a` (an HTTP(S) href is required for `a`, otherwise
pass `null`), preserving existing text-source bytes. Unwrapping requires that
the matching wrapper directly own that text node as its only child. It splits
retained prefix/suffix text into wrappers, retaining identity attributes only
on the first remaining wrapper. An `a` may retain `href`; other non-identity
attributes refuse. Both operations reparse and refuse unsafe tree repair.
The canvas RPC separately compares the selected decoded source quote (or the
full direct text node for retyping) with the frame's `expectedText`: a matching
file hash does not certify text changed by a running script.

Paste validation uses `hasCompleteHtmlTokens(text)` to require the fragment's
tokenizer to reach data state before EOF recovery, and `textInSourceRange(text,
node, range)` to compare retained text even when adjacent text nodes merge.
The latter returns null if a range splits an entity or normalized CRLF.
`hasSafeStyleUrls(css)` scans declarations and decoded CSS component values,
allowing only HTTP(S) or relative resource URLs. It preserves quoted non-URL
text, refuses inline import rules, and refuses unresolved `var()`/`env()` in
URL-bearing functions. This is a paste policy, not general CSS validation.

`readRootCustomProperties(text)` returns `{ok: true, properties}` with
`{name, value, important}` for each winning custom property in the first
top-level `:root` rule of the first literal HTML `style` element.
`setRootCustomProperty(text, name, value)` edits that same rule, returning
`{ok: true, text, splices}`. It shares inline CSS's declaration scanning and
winner rules, preserves raw CSS bytes outside the changed declaration, and
rejects values that could close the style element. A null value removes all
declarations of that name. Missing containers refuse with `missing-style` or
`missing-root`; these helpers never create a stylesheet or a root rule.
