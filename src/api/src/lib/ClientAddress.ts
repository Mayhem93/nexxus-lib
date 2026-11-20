import { isIP } from 'node:net';

import type { Request, Response, NextFunction } from 'express';

/**
 * The client's IP address as the API reads it (`req.ip`): the address the
 * connection comes from, or, behind proxies (`trustProxy`), an address out of
 * `X-Forwarded-For`.
 */
export class NexxusApiClientAddress {
  /** `[address]:port`: how a proxy writes an IPv6 address with the client's port. */
  private static readonly BRACKETED_WITH_PORT = /^\[([^\]]+)\]:\d+$/;

  /** `address:port`: how a proxy writes an IPv4 address with the client's port. */
  private static readonly WITH_PORT = /^([^:]+):\d+$/;

  /**
   * Middleware: drop the port from every `X-Forwarded-For` entry written with
   * one, as an AWS ALB does with `routing.http.xff_client_port.enabled`.
   * Whichever entry `trustProxy` picks is then an address alone; with the port
   * kept, every connection of one client would count as a client of its own.
   */
  public static stripForwardedPorts(req: Request, _res: Response, next: NextFunction): void {
    const header = req.headers['x-forwarded-for'];

    if (typeof header === 'string') {
      req.headers['x-forwarded-for'] = header
        .split(',')
        .map(entry => NexxusApiClientAddress.withoutPort(entry.trim()))
        .join(', ');
    }

    next();
  }

  /** `entry` without its port when it is an address written with one; any other entry as it is. */
  private static withoutPort(entry: string): string {
    const withPort = NexxusApiClientAddress.BRACKETED_WITH_PORT.exec(entry) ?? NexxusApiClientAddress.WITH_PORT.exec(entry);

    return withPort && isIP(withPort[1]!) ? withPort[1]! : entry;
  }
}
