import { compress as lz4Compress, uncompress as lz4Uncompress } from 'lz4-napi';

/**
 * All algo names this codebase currently knows how to construct. Kept as a
 * const union so the config schema and the runtime switch below stay in
 * lock-step; add a new algo here first, then a case in the constructor and
 * one each in `compress` / `decompress`.
 */
export const NEXXUS_COMPRESSION_ALGOS = ['lz4'] as const;

export type NexxusCompressionAlgo = typeof NEXXUS_COMPRESSION_ALGOS[number];

/**
 * Per-adapter compression config. Lives on the MQ adapter config block.
 * When `enabled` is false, `algo` is still required so operators can flip
 * the switch back on without re-authoring the block. Absent config
 * altogether = disabled.
 */
export interface NexxusCompressionConfig {
  enabled: boolean;
  algo: NexxusCompressionAlgo;
  /** Algo-specific tunables. Shape is up to the algo. */
  options: Record<string, any>;
}

/**
 * Single home for every compression algo the MQ layer supports. New algos
 * land here — one case in the constructor validator plus one branch each
 * in `compress` and `decompress`.
 *
 * Chosen shape: one class with an internal switch, not one class per algo.
 * The algos share nothing structurally (no shared state, no per-algo
 * lifecycle beyond the config), so subclassing would just add ceremony.
 *
 * Compression policy is deployment-wide: every producer and every consumer
 * in the deployment must run the same algo config. Rolling a change means
 * draining the queues first — messages carry no per-message algo marker.
 */
export class NexxusMessageCompressor {
  private readonly algo: NexxusCompressionAlgo;
  private readonly options: Record<string, any>;

  constructor(config: NexxusCompressionConfig) {
    if (!config.enabled) {
      throw new Error(
        'NexxusMessageCompressor: must not be constructed when compression.enabled is false — callers should check the flag first'
      );
    }

    if (!(NEXXUS_COMPRESSION_ALGOS as readonly string[]).includes(config.algo)) {
      throw new Error(
        `NexxusMessageCompressor: unsupported algo "${config.algo}". Supported: ${NEXXUS_COMPRESSION_ALGOS.join(', ')}`
      );
    }

    this.algo = config.algo;
    this.options = config.options;
  }

  public compress(input: Buffer): Promise<Buffer> {
    switch (this.algo) {
      case 'lz4':
        // Standard-mode LZ4. Deliberately not passing the HC/dictionary
        // options — target is ~50% ratio at minimum CPU cost. `options`
        // is unused today; wired up so future algos can consume it.
        return lz4Compress(input);
    }
  }

  public decompress(input: Buffer): Promise<Buffer> {
    switch (this.algo) {
      case 'lz4':
        return lz4Uncompress(input);
    }
  }
}
