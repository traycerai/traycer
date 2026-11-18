/**
 * Keeping the content under the fingers still across a zoom that reflows.
 *
 * The Word viewer zooms with CSS `zoom`, so a scale change moves every
 * document point to `contentOffset + point * scale` inside the scroll
 * container. Along one axis: read the document point under the focal before
 * the zoom, then choose the scroll offset that puts it back under the focal
 * after. `contentOffset` is the document's offset inside the scroll
 * container (its gutter), which the zoom does not touch.
 */
export function documentPointUnder(
  scrollOffset: number,
  focalInContainer: number,
  contentOffset: number,
  scale: number,
): number {
  return (scrollOffset + focalInContainer - contentOffset) / scale;
}

export function scrollOffsetPlacing(
  documentPoint: number,
  scale: number,
  contentOffset: number,
  focalInContainer: number,
): number {
  return contentOffset + documentPoint * scale - focalInContainer;
}
