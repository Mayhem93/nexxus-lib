import { NexxusConfig } from '@mayhem93/nexxus-core-lib';

import { NexxusMessageQueueAdapter, NexxusMessageQueueBootstrapper } from './MessageQueueAdapter';

/**
 * Per-call bootstrap secrets. The adapter's own config supplies the admin
 * credentials it uses at runtime (and that the bootstrapper reuses to
 * authenticate to the management API); these two fields identify the
 * runtime user the bootstrapper CREATES on that admin's behalf. Callers
 * populate this — the CLI from its args, the Hub API from the HTTP body.
 */
export interface NexxusRabbitMqBootstrapOptions {
  runtimeUser: string;
  runtimePassword: string;
}

/**
 * Config surface the bootstrapper reads from the adapter. Kept narrow on
 * purpose — the bootstrapper doesn't need the full `RabbitMQConfig`, and
 * decoupling the shape here means we won't touch this file every time an
 * unrelated adapter field is added.
 */
export interface NexxusRabbitMqBootstrapAdapterConfig extends NexxusConfig {
  host: string;
  user: string;
  password: string;
  managementPort: number;
}

/**
 * RabbitMQ-specific deployment bootstrapper. Runs entirely against the
 * broker's HTTP management API — no AMQP connection required, so the CLI
 * can invoke it before any adapter has successfully `connect()`ed (the
 * whole point: it's what creates the vhost the adapter will later connect
 * to).
 *
 * Auth to the management API uses the adapter config's `user`/`password`,
 * which on CLI/Hub is the RabbitMQ super-user. On worker nodes the same
 * config carries the runtime user — so nodes shouldn't be calling
 * `getBootstrapper()` at all; that's a CLI/Hub responsibility.
 *
 * Declares, in order:
 *   1. The target vhost.
 *   2. The runtime user (from `options.runtimeUser` / `runtimePassword`),
 *      with no admin tags.
 *   3. Runtime user permissions on that vhost, and only that vhost
 *      (RabbitMQ permissions are per-vhost; not granting anywhere else is
 *      implicit).
 *   4. The `systemMessages` fanout exchange — the cross-node broadcast
 *      surface. See the "no bindings on purpose" note near the queue
 *      declaration below for why nothing binds to it here.
 *   5. One durable quorum queue per static pipeline stage. Dynamic-pattern
 *      stages (`websockets-transport`, `mqtt-transport`) are skipped —
 *      their per-slot queues (`<stage>_<N>`) are declared by the worker
 *      that picks the slot.
 *
 * All management-API PUTs are natively idempotent on RabbitMQ, so re-runs
 * are safe by construction.
 */
export class NexxusRabbitMqBootstrapper
  extends NexxusMessageQueueBootstrapper<NexxusRabbitMqBootstrapOptions>
{
  private static readonly LOGGER_LABEL = 'NxxMqBootstrap';
  private static readonly VHOST = '/nexxus';
  private static readonly SYSTEM_MESSAGES_EXCHANGE = 'systemMessages';

  /**
   * Pipeline stages whose runtime queues are per-slot (`<stage>_<N>`)
   * rather than a single durable queue named after the stage. See the note
   * in the class docstring — kept in sync with core's
   * `NexxusDynamicQueuePayloadMap` by convention until a shared runtime
   * const removes the drift risk.
   */
  private static readonly DYNAMIC_STAGES: ReadonlySet<string> = new Set([
    'websockets-transport',
    'mqtt-transport',
  ]);

  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(options: NexxusRabbitMqBootstrapOptions, config: NexxusRabbitMqBootstrapAdapterConfig) {
    super(options);
    this.baseUrl = `http://${config.host}:${config.managementPort}`;
    this.authHeader = 'Basic ' + Buffer.from(`${config.user}:${config.password}`).toString('base64');
  }

  public async bootstrapDeployment(pipeline: string[]): Promise<void> {
    const vhostPath = encodeURIComponent(NexxusRabbitMqBootstrapper.VHOST);
    const userPath = encodeURIComponent(this.options.runtimeUser);

    await this.putMgmt(`/api/vhosts/${vhostPath}`);
    
    NexxusMessageQueueAdapter.logger.info(
      `Declared vhost ${NexxusRabbitMqBootstrapper.VHOST}`,
      NexxusRabbitMqBootstrapper.LOGGER_LABEL,
    );

    await this.putMgmt(`/api/users/${userPath}`, {
      password: this.options.runtimePassword,
      tags: '',
    });
    NexxusMessageQueueAdapter.logger.info(
      `Declared user ${this.options.runtimeUser}`,
      NexxusRabbitMqBootstrapper.LOGGER_LABEL,
    );

    await this.putMgmt(`/api/permissions/${vhostPath}/${userPath}`, {
      configure: '.*',
      write: '.*',
      read: '.*',
    });
    NexxusMessageQueueAdapter.logger.info(
      `Granted ${this.options.runtimeUser} full permissions on ${NexxusRabbitMqBootstrapper.VHOST}`,
      NexxusRabbitMqBootstrapper.LOGGER_LABEL,
    );

    // Declared with no bindings on purpose. The pipeline-stage queues
    // below are for work traffic (competing consumers, one message → one
    // worker); system-message broadcast (one message → every node) is a
    // separate topology where each worker binds its own ephemeral queue
    // on startup. Mixing the two would either miss broadcast recipients
    // or double-deliver work to every node.
    await this.putMgmt(
      `/api/exchanges/${vhostPath}/${encodeURIComponent(NexxusRabbitMqBootstrapper.SYSTEM_MESSAGES_EXCHANGE)}`,
      {
        type: 'fanout',
        durable: true,
      },
    );
    NexxusMessageQueueAdapter.logger.info(
      `Declared fanout exchange ${NexxusRabbitMqBootstrapper.SYSTEM_MESSAGES_EXCHANGE}`,
      NexxusRabbitMqBootstrapper.LOGGER_LABEL,
    );

    for (const stage of pipeline) {
      if (NexxusRabbitMqBootstrapper.DYNAMIC_STAGES.has(stage)) {
        NexxusMessageQueueAdapter.logger.debug(
          `Skipping dynamic-pattern stage "${stage}" — per-slot queues are declared by the workers themselves`,
          NexxusRabbitMqBootstrapper.LOGGER_LABEL,
        );

        continue;
      }

      await this.putMgmt(`/api/queues/${vhostPath}/${encodeURIComponent(stage)}`, {
        durable: true,
        arguments: { 'x-queue-type': 'quorum' },
      });

      NexxusMessageQueueAdapter.logger.info(
        `Declared queue ${stage}`,
        NexxusRabbitMqBootstrapper.LOGGER_LABEL,
      );
    }
  }

  /**
   * Thin PUT wrapper over the RabbitMQ management API. Every declare
   * operation the bootstrapper does is a PUT, and every one of them takes
   * either an empty body (vhost) or a small JSON blob. Non-2xx responses
   * throw with the broker's error text so callers see the reason.
   */
  private async putMgmt(path: string, body?: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');

      throw new Error(
        `RabbitMQ management API PUT ${path} failed with ${res.status} ${res.statusText}: ${detail}`,
      );
    }
  }
}
