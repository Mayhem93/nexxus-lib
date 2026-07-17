/**
 * HTTP client for the Nexxus Hub node-registry endpoints. Class-based so
 * each service (API, BaseWorker, adapters that grow Hub-awareness later)
 * carries its own config and retry-loop state.
 *
 * Hub is treated as a soft dependency: register / list operations retry
 * transparently until Hub is reachable. `unregisterNode` deliberately does
 * NOT retry — a lingering retry timer at shutdown would keep the process
 * alive, breaking graceful exit.
 *
 * Wire contract lives in `nexxus-hub-api/src/lib/routes/Node.ts`.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';

import { NexxusBaseLogger } from './Logger';

/**
 * Where Hub lives and the shared secret it expects.
 */
export type NexxusHubClientConfig = {
  /** Hub base URL, e.g. `http://hub.internal:8080`. Trailing slashes are trimmed. */
  endpoint: string;
  /** Shared secret sent in the `Nxx-Hub-Token` header on every request. */
  token: string;
};

/**
 * A node in Hub's registry. Sent as-is on `POST /node`; returned as-is
 * from `GET /node`. Field names match Hub's route contract verbatim.
 *
 * Note: the id key is `id`, NOT `nodeId` — Hub destructures `id` off the body.
 */
export type NexxusHubNode = {
  /** Fresh uuid v4 minted per node boot; hold locally so `unregisterNode()` can reference it. */
  id: string;
  /** Node role: `'api' | 'writer' | 'websockets-transport' | ...` — free-form string, no server-side enum. */
  role: string;
  /** Node's private-network IPv4, discovered via `discoverPrivateIpAddress` or overridden. */
  privateIpAddress: string;
  /** Management port for the node. */
  managementPort: number;
  /** Installed `@mayhem93/*` package versions, for fleet version-drift visibility. */
  dependencies: Record<string, string>;
  /** `getStats()` snapshot at registration time — Hub does not refresh this after boot. */
  stats: Record<string, unknown>;
  /**
   * Slot number for volatile-transport nodes (websockets-transport,
   * mqtt-transport, …). Undefined for non-volatile roles (api, writer, …)
   * that don't participate in slot pools.
   */
  slot?: number;
};

/**
 * The set of `@mayhem93/nexxus-*` packages a node scans for in its
 * `node_modules` when building the `dependencies` map for `POST /node`.
 * Not every node has all of them installed — missing ones are silently
 * omitted from the payload rather than treated as errors.
 */
export const NEXXUS_DEPENDENCY_NAMES = [
  '@mayhem93/nexxus-core-lib',
  '@mayhem93/nexxus-database-lib',
  '@mayhem93/nexxus-message-queue-lib',
  '@mayhem93/nexxus-redis',
  '@mayhem93/nexxus-api-lib',
  '@mayhem93/nexxus-worker-lib',
] as const;

export class NexxusHubClient {
  private static readonly HUB_TOKEN_HEADER = 'Nxx-Hub-Token';
  private static readonly REQUEST_TIMEOUT_MS = 1000;
  private static readonly RETRY_INTERVAL_MS = 30_000;
  /**
   * How often we re-POST /node after the initial registration succeeds.
   * Hub's registry is in-memory (v1) so a Hub restart wipes it — periodic
   * re-register recreates the entry within one tick.
   */
  private static readonly REREGISTER_INTERVAL_MS = 30_000;
  private static readonly LOGGER_LABEL = 'NxxHubClient';

  private readonly baseUrl: string;
  /**
   * Set by `dispose()`. Checked at the top of every `retryUntilSuccess`
   * iteration AND before every re-register tick, so both loops bail out
   * cleanly on shutdown.
   */
  private disposed: boolean = false;
  /**
   * Timer for the periodic re-register loop. Non-null only between the
   * first successful register and `dispose()`. `.unref()` on it so it
   * never keeps the process alive on its own.
   */
  private reregisterTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: NexxusHubClientConfig,
    private readonly logger: NexxusBaseLogger<any>,
  ) {
    this.baseUrl = config.endpoint.replace(/\/+$/, '');
  }

  /**
   * Register this node with Hub. Retries transparently until Hub accepts
   * the payload or `dispose()` is called. Since retry is invisible,
   * callers can either `await` (block until Hub is up) or fire-and-forget
   * (`void hubClient.registerNode(...)`) depending on whether they need
   * Hub connectivity before proceeding.
   *
   * `buildPayload` is a function (not a value) so each attempt captures a
   * fresh `getStats()` snapshot and re-runs IP / dependency discovery in
   * case those weren't available at the first try (network not fully up
   * yet in a container, etc.). The `id` field should be stable across
   * attempts so Hub upserts idempotently on any partial success.
   */
  public async registerNode(buildPayload: () => Promise<NexxusHubNode>): Promise<NexxusHubNode> {
    const first = await this.retryUntilSuccess(async () => {
      const payload = await buildPayload();

      await this.doJson('POST', '/node', payload);

      return payload;
    }, 'registerNode');

    // After first success, keep the entry alive across Hub restarts by
    // re-POSTing on an interval. Idempotent upsert (Hub keys on `id`), so
    // a running Hub sees no-op-shaped writes; a restarted Hub picks the
    // node back up within one tick.
    this.startReregisterLoop(buildPayload);

    return first;
  }

  /**
   * List nodes currently registered under the given role. Retries — the
   * volatile-transport worker startup path relies on this to pick a slot,
   * and can't proceed without an answer.
   *
   * The `slot` field on returned records is undefined for nodes that
   * don't have one (i.e. non-volatile roles).
   */
  public listNodesByRole(role: string): Promise<NexxusHubNode[]> {
    return this.retryUntilSuccess(
      () => this.doJson<NexxusHubNode[]>('GET', `/node?role=${encodeURIComponent(role)}`),
      'listNodesByRole',
    );
  }

  /**
   * De-register this node from Hub. Does NOT retry — a lingering retry
   * timer here would prevent the process from exiting cleanly during
   * shutdown. Throws on failure; callers should catch-and-continue, since
   * Hub-registry drift heals on the next Hub restart anyway.
   */
  public async unregisterNode(nodeId: string): Promise<void> {
    await this.doJson('DELETE', `/node/${encodeURIComponent(nodeId)}`);
  }

  /**
   * Cancel any in-flight retry loops. Call during graceful shutdown so
   * no `retryUntilSuccess` await gets stuck if the process is otherwise
   * still running.
   *
   * `setTimeout(...).unref()` on our sleep timers already prevents them
   * from keeping the process alive on their own — `dispose()` is for the
   * explicit early-cancel case, not for basic process-exit hygiene.
   */
  public dispose(): void {
    this.disposed = true;

    if (this.reregisterTimer) {
      clearInterval(this.reregisterTimer);
      this.reregisterTimer = null;
    }
  }

  /**
   * Kick off the re-register interval. Failures in a tick log at `warn`
   * and wait for the next tick — no fast retry inside the tick, because
   * the interval already IS the retry cadence.
   *
   * Guarded against overlap: if a tick's payload build + POST hasn't
   * finished by the time the next tick fires, we skip that tick rather
   * than pile up concurrent registers.
   */
  private startReregisterLoop(buildPayload: () => Promise<NexxusHubNode>): void {
    if (this.reregisterTimer || this.disposed) {
      return;
    }

    let tickInFlight = false;
    // Tracks whether the previous tick failed. When a tick succeeds after
    // one or more failures, we log an info-level "recovered" message so
    // operators see the recovery event in node logs — otherwise successful
    // ticks are silent (they're the expected steady state and would be
    // pure spam every REREGISTER_INTERVAL_MS).
    let previousTickFailed = false;

    const tick = async (): Promise<void> => {
      if (this.disposed || tickInFlight) {
        return;
      }

      tickInFlight = true;

      try {
        const payload = await buildPayload();

        if (this.disposed) {
          return;
        }

        await this.doJson('POST', '/node', payload);

        if (previousTickFailed) {
          this.logger.info(
            `Hub re-register recovered — connection to Hub re-established`,
            NexxusHubClient.LOGGER_LABEL,
          );
          previousTickFailed = false;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        this.logger.warn(
          `Hub re-register failed (waiting ${NexxusHubClient.REREGISTER_INTERVAL_MS}ms for next tick): ${msg}`,
          NexxusHubClient.LOGGER_LABEL,
        );
        previousTickFailed = true;
      } finally {
        tickInFlight = false;
      }
    };

    this.reregisterTimer = setInterval(() => { void tick(); }, NexxusHubClient.REREGISTER_INTERVAL_MS);
    this.reregisterTimer.unref();
  }

  /**
   * Read installed `@mayhem93/nexxus-*` versions from the running app's
   * `node_modules` for the Hub registration payload. Anchored on
   * `process.cwd()` so it resolves against the runnable's install tree,
   * not this library's — same convention as `ServiceResolver`.
   *
   * Packages that aren't installed are omitted (no error). This lets a
   * worker process register without needing the API package installed
   * just so this call succeeds.
   */
  public static readNexxusDependencies(): Record<string, string> {
    const deps: Record<string, string> = {};

    for (const name of NEXXUS_DEPENDENCY_NAMES) {
      try {
        const pkgJsonPath = path.join(process.cwd(), 'node_modules', name, 'package.json');
        const parsed = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));

        if (typeof parsed.version === 'string') {
          deps[name] = parsed.version;
        }
      } catch {
        // Not installed — skip silently.
      }
    }

    return deps;
  }

  /**
   * Pick the first non-internal IPv4 address from the machine's network
   * interfaces. Right for most container / VM / single-NIC-host cases; if
   * you have multiple NICs and need a specific one, callers should read a
   * config override and pass that string instead.
   *
   * Throws if no non-internal IPv4 is found — a node with only 127.0.0.1
   * has nothing useful to report to Hub anyway.
   */
  public static discoverPrivateIpAddress(): string {
    const interfaces = os.networkInterfaces();

    for (const nets of Object.values(interfaces)) {
      for (const net of nets ?? []) {
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }

    throw new Error('discoverPrivateIpAddress: no non-internal IPv4 address found on any network interface');
  }

  private async retryUntilSuccess<T>(op: () => Promise<T>, opName: string): Promise<T> {
    while (true) {
      if (this.disposed) {
        throw new Error(`NexxusHubClient disposed while ${opName} was retrying`);
      }

      try {
        return await op();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        this.logger.warn(
          `Hub ${opName} failed, retrying in ${NexxusHubClient.RETRY_INTERVAL_MS}ms: ${msg}`,
          NexxusHubClient.LOGGER_LABEL,
        );

        await this.unrefSleep(NexxusHubClient.RETRY_INTERVAL_MS);
      }
    }
  }

  private unrefSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);

      // Key bit — this timer never keeps the process alive on its own. If
      // everything else has shut down while we're mid-sleep, the process
      // exits cleanly and this promise never resolves (which is fine —
      // the awaiter is going down with the process).
      t.unref();
    });
  }

  /**
   * Shared fetch wrapper. All Hub calls: optional JSON body in, JSON body
   * out (or empty), `Nxx-Hub-Token` auth header, per-request timeout.
   * Non-2xx throws with Hub's error text so callers see the reason.
   */
  private async doJson<TResponse = void>(
    method: 'GET' | 'POST' | 'DELETE',
    requestPath: string,
    body?: unknown,
  ): Promise<TResponse> {
    const res = await fetch(`${this.baseUrl}${requestPath}`, {
      method,
      headers: {
        [NexxusHubClient.HUB_TOKEN_HEADER]: this.config.token,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(NexxusHubClient.REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');

      throw new Error(
        `Hub ${method} ${requestPath} failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`,
      );
    }

    // 204 / empty body: nothing to parse.
    if (res.status === 204 || res.headers.get('content-length') === '0') {
      return undefined as TResponse;
    }

    // Best-effort JSON parse. If Hub returns non-JSON on a 2xx (shouldn't,
    // but defensive), treat it as an empty response rather than throwing.
    try {
      return (await res.json()) as TResponse;
    } catch {
      return undefined as TResponse;
    }
  }
}
