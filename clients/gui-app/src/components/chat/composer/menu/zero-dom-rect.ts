/**
 * Zero-size fallback for a floating-ui virtual reference's
 * `getBoundingClientRect()` when nothing is measurable yet (e.g. the caret
 * or active row rect isn't available on the first render). `DOMRect` isn't
 * guaranteed to exist as a constructible global in every environment this
 * module can load in, so fall back to a plain object of the same shape.
 */
export const ZERO_DOM_RECT: DOMRect =
  typeof DOMRect === "function"
    ? new DOMRect(0, 0, 0, 0)
    : {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      };
