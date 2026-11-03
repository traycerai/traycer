/**
 * Visual feedback only. `transition-all` also interpolates flex-shrink,
 * padding and the rest of the box, so a control that changes size keeps its
 * old box for the whole 150ms. In the header that shoves the trailing
 * controls past the header's edge until the interpolation ends, which is
 * what the 900px header-fit check caught mid-flight.
 *
 * `background-image` stays: press-scrim's release fade is that property
 * (`index.css`). `cn` puts this list in the same group as `transition-none`
 * and `transition-opacity`, so a caller that names its own transition still
 * replaces it.
 */
export const CONTROL_TRANSITION =
  "transition-[color,background-color,background-image,border-color,outline-color,text-decoration-color,fill,stroke,box-shadow,opacity]";
