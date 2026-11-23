/**
 * Whether a dialog's read has answered since the dialog opened and is not
 * being read again. The cache can still hold an earlier opening's answer,
 * which is not what the computer would answer now.
 */
export function answeredThisOpening(read: {
  readonly isFetchedAfterMount: boolean;
  readonly isFetching: boolean;
}): boolean {
  return read.isFetchedAfterMount && !read.isFetching;
}
