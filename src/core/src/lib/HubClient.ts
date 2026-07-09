/**
 * HTTP client for the Nexxus Hub node-registry endpoints, plus the small
 * helpers a node needs to build its registration payload. Kept as
 * exported functions rather than a class — statelessness fits the
 * two-shot register/unregister lifecycle, and holding a class here would
 * imply state (a client instance) that isn't actually needed.
 *
 * Callers should treat register/unregister as best-effort and continue on
 * failure: Hub is a soft dependency, a Hub outage must not block node
 * startup or crash a node during shutdown.
 *
 * Uses Node's global `fetch`. No retries in v1 — a Hub restart wipes the
 * registry anyway, and nodes only re-register on their own next boot.
 *
 * Wire contract lives in `nexxus-hub-api/src/lib/routes/Node.ts`.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Where Hub lives and the shared secret it expects.
 */
export type HubClientConfig = {
  /** Hub base URL, e.g. `http://hub.internal:8080`. Trailing slashes are trimmed. */
  endpoint: string;
  /** Shared secret sent in the `Nxx-Hub-Token` header on every request. */
  token: string;
};

/**
 * Payload for `POST /node`. Field names match Hub's route contract verbatim.
 * Note: the id key is `id`, NOT `nodeId` — Hub destructures `id` off the body.
 */
export type NodeRegistration = {
  /** Fresh uuid v4 minted per node boot; hold locally so `unregisterNode()` can reference it. */
  id: string;
  /** Node role: `'api' | 'writer' | ...` — free-form string, no server-side enum. */
  role: string;
  /** Node's private-network IPv4, discovered by the caller (`discoverPrivateIpAddress` or override). */
  privateIpAddress: string;
  /** Management port for the node. */
  managementPort: number;
  /** Installed `@mayhem93/*` package versions, for fleet version-drift visibility. */
  dependencies: Record<string, string>;
  /** `getStats()` snapshot at registration time — Hub does not refresh this after boot. */
  stats: Record<string, unknown>;
};

const HUB_TOKEN_HEADER = 'Nxx-Hub-Token';
const HUB_REQUEST_TIMEOUT_MS = 1000;

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

/**
 * Trim trailing slashes so `${base}/node` doesn't produce a double slash.
 * The base URL should carry no path; if callers pass one, that's their
 * problem to notice via the resulting 404.
 */
function normalizeBase(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

/**
 * Register this node with Hub. Called once during `init()` after all local
 * services are up. Throws on network failure, non-2xx response, or timeout —
 * callers should catch and log, then continue (Hub is a soft dependency).
 */
export async function registerNode(cfg: HubClientConfig, payload: NodeRegistration): Promise<void> {
  const res = await fetch(`${normalizeBase(cfg.endpoint)}/node`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [HUB_TOKEN_HEADER]: cfg.token,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(HUB_REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');

    throw new Error(`Hub registerNode failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
  }
}

/**
 * De-register this node with Hub. Called during graceful shutdown, before
 * the process exits. Idempotent on Hub's side — a missing id still returns
 * 204. Same soft-dep semantics as `registerNode`: catch and continue.
 */
export async function unregisterNode(cfg: HubClientConfig, nodeId: string): Promise<void> {
  const res = await fetch(`${normalizeBase(cfg.endpoint)}/node/${encodeURIComponent(nodeId)}`, {
    method: 'DELETE',
    headers: {
      [HUB_TOKEN_HEADER]: cfg.token,
    },
    signal: AbortSignal.timeout(HUB_REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');

    throw new Error(`Hub unregisterNode failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
  }
}

/**
 * Read installed `@mayhem93/nexxus-*` versions from the running app's
 * `node_modules` for the Hub registration payload. Anchored on
 * `process.cwd()` so it resolves against the runnable's install tree, not
 * this library's — same convention as `ServiceResolver`.
 *
 * Packages that aren't installed are omitted (no error). This is what lets
 * a worker process register without needing the API package installed just
 * so this call succeeds.
 */
export function readNexxusDependencies(): Record<string, string> {
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
export function discoverPrivateIpAddress(): string {
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

/**
 * Handle returned by `registerNodeWithRetry`, controlling the retry loop's
 * lifetime. Callers hold onto this and call `stop()` during shutdown so the
 * interval clears and no register attempts fire after `close()`.
 */
export type HubRegistrationHandle = {
  /**
   * Cancel the retry loop. Idempotent — safe to call whether registration
   * has succeeded, is still retrying, or was never started. After this
   * call, no further register attempts fire and no callbacks are invoked.
   */
  stop(): void;
};

const DEFAULT_RETRY_INTERVAL_MS = 30_000;

/**
 * Kick off a background retry loop that keeps calling `registerNode` until
 * it succeeds or `stop()` is called on the returned handle. Since Hub is a
 * soft dependency and nodes never re-register spontaneously, the loop
 * runs from boot until first success only — a Hub outage present at boot
 * doesn't strand the node forever.
 *
 * `buildPayload` is a function (not a value) so each attempt can capture a
 * fresh `getStats()` snapshot and can also retry IP / dependency discovery
 * in case any of those weren't available at the moment of the first try
 * (network not fully up yet in a container, etc.). Payload `id` should be
 * stable across attempts so Hub upserts idempotently on any partial
 * success.
 *
 * Failures go to `onError` and never throw — the loop keeps running. The
 * first success fires `onSuccess` exactly once and the loop stops on its
 * own.
 */
export function registerNodeWithRetry(
  cfg: HubClientConfig,
  buildPayload: () => Promise<NodeRegistration>,
  opts: {
    retryIntervalMs?: number;
    onSuccess?: (nodeId: string) => void;
    onError?: (err: Error) => void;
  } = {}
): HubRegistrationHandle {
  const retryIntervalMs = opts.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let succeeded = false;
  let inflight = false;

  const attempt = async (): Promise<void> => {
    if (stopped || succeeded || inflight) {
      return;
    }
    inflight = true;

    try {
      const payload = await buildPayload();

      await registerNode(cfg, payload);

      if (stopped) {
        return;
      }
      succeeded = true;

      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      opts.onSuccess?.(payload.id);
    } catch (err) {
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      inflight = false;
    }
  };

  // Fire the first attempt immediately so a successful startup doesn't
  // wait out the interval before appearing in Hub.
  void attempt();

  // Subsequent attempts on the interval. `unref` so the timer alone
  // doesn't keep the process alive if everything else has shut down.
  timer = setInterval(() => {
    void attempt();
  }, retryIntervalMs);
  timer.unref();

  return {
    stop(): void {
      stopped = true;

      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
