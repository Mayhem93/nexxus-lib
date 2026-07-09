import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { serve } from '@hono/node-server';

/**
 * Minimal contract a host (`NexxusApi`, `NexxusBaseWorker`, or a custom
 * node class) exposes to its management server. The server only needs
 * to fetch the host's current stats — anything else the endpoints
 * report (uptime, liveness) the server derives itself from `process`.
 *
 * Intentionally narrow so consumer classes don't have to implement any
 * new methods purely to run a management server: `getStats()` is
 * already required by `NexxusBaseService`.
 */
export interface ManagementServerHost {
  getStats(): Promise<Record<string, unknown>>;
}

/**
 * Configuration for the management HTTP server. If you don't want to
 * expose management endpoints on a node, don't construct one at all —
 * both fields are required when it IS enabled.
 */
export type NexxusManagementServerConfig = {
  /** TCP port to listen on. Should not collide with any other server the host runs. */
  port: number;
  /**
   * Bearer token clients must present in the `Authorization` header.
   * The `/stats` endpoint requires it; missing or wrong token yields
   * a 401.
   */
  token: string;
};

/**
 * Small HTTP server that exposes per-node observability on a dedicated
 * port. Every Nexxus node (API, workers, custom nodes) runs one;
 * consumed by external tools (CLI, monitoring, humans) and — as an
 * optional out-of-band path — by Hub or a future dashboard when they
 * want a fresh stats snapshot beyond what registration captured.
 *
 * **Endpoint:**
 *
 *   `GET /stats` — the host's `getStats()` payload verbatim (includes
 *   `uptime`; a successful response also implies liveness, so a
 *   separate `/status` route would be redundant).
 *
 * **Auth**: `Authorization: Bearer <token>` on the endpoint. Missing
 * or wrong token returns 401 with no body — no leaking of what the
 * endpoint is to unauthorized callers.
 *
 * Built on Hono + `@hono/node-server` — chosen for its tiny footprint
 * and the ability to grow (middleware pipeline, path params, response
 * streaming, etc.) without swapping frameworks. Both are single-package
 * deps with no transitive bloat.
 */
export class NexxusManagementServer {
  private server: ReturnType<typeof serve> | null = null;

  constructor(
    private readonly host: ManagementServerHost,
    private readonly config: NexxusManagementServerConfig,
  ) {}

  /**
   * Start listening. Not idempotent — a second call while already running
   * throws. Callers that want restart semantics should `close()` first.
   */
  public start(): Promise<void> {
    if (this.server !== null) {
      throw new Error('Management server is already running');
    }

    const app = new Hono();

    // Bearer auth on every route. Applied once at the
    // subtree — no per-route repetition, and future endpoints under
    // /* are protected automatically.
    app.use('/*', bearerAuth({ token: this.config.token }));

    app.get('/stats', async (c) => {
      const stats = await this.host.getStats();

      return c.json(stats);
    });

    this.server = serve({
      fetch: app.fetch,
      port: this.config.port,
    });

    return new Promise((resolve, reject) => {
      this.server?.once('listening', resolve);
      this.server?.once('error', reject);
    });
  }

  /**
   * Stop listening. Existing in-flight requests are allowed to complete
   * before the underlying HTTP server actually closes. Idempotent —
   * calling on a not-running server is a no-op.
   */
  public close(): void {
    this.server?.close();
    this.server = null;
  }
}
