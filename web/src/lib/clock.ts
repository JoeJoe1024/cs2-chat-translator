let last = 0;

/**
 * A strictly increasing click time (ms since epoch). The server uses it to order preparations: when two requests are
 * in flight (a slow translation and a quick direct message), the one clicked LATER wins no matter which answers first.
 */
export function nextClick(): number {
  last = Math.max(Date.now(), last + 1);
  return last;
}
