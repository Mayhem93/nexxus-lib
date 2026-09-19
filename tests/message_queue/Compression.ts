import { describe, it, expect } from 'vitest';
import { NexxusMessageCompressor, type NexxusCompressionConfig } from '@mayhem93/nexxus-message-queue-lib';

const config = (over: Partial<NexxusCompressionConfig> = {}): NexxusCompressionConfig => ({
  enabled: true,
  algo: 'lz4',
  options: {},
  ...over,
});

describe('NexxusMessageCompressor constructor', () => {
  it('constructs with a valid enabled lz4 config', () => {
    expect(() => new NexxusMessageCompressor(config())).not.toThrow();
  });

  it('throws when constructed with compression disabled', () => {
    expect(() => new NexxusMessageCompressor(config({ enabled: false })))
      .toThrow(/must not be constructed when compression.enabled is false/);
  });

  it('throws on an unsupported algo', () => {
    expect(() => new NexxusMessageCompressor(config({ algo: 'zstd' as never })))
      .toThrow(/unsupported algo "zstd"/);
  });
});

describe('NexxusMessageCompressor compress/decompress (real lz4)', () => {
  it('round-trips a buffer back to the original bytes', async () => {
    const compressor = new NexxusMessageCompressor(config());
    const input = Buffer.from(JSON.stringify({ hello: 'world', nums: [1, 2, 3], nested: { a: true } }));

    const compressed = await compressor.compress(input);
    const restored = await compressor.decompress(compressed);

    expect(Buffer.isBuffer(compressed)).toBe(true);
    expect(restored.equals(input)).toBe(true);
  });

  it('actually reduces the size of a compressible payload', async () => {
    const compressor = new NexxusMessageCompressor(config());
    const input = Buffer.from('a'.repeat(10_000)); // highly compressible

    const compressed = await compressor.compress(input);

    expect(compressed.length).toBeLessThan(input.length);
    expect((await compressor.decompress(compressed)).equals(input)).toBe(true);
  });
});
