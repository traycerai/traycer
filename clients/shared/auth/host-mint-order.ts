let drawn = 0;

/**
 * This process's one request clock for host-only token mints, drawn as each
 * authn request is sent: every source and client in the process orders its
 * requests on it, so a request sent later always holds the higher order.
 */
export function drawHostMintOrder(): number {
  drawn += 1;
  return drawn;
}
