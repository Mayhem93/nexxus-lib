import { NexxusRedis } from '../Redis';
import { NEXXUS_PREFIX_LC } from '@mayhem93/nexxus-core-lib';

/**
 * Partial per-object field cache backing ACL condition evaluation. One Redis
 * HASH per object at `nxx:field-cache:{objectId}`, holding a small projection
 * of the object's fields — the builtin immutable ones (id / userId / createdAt)
 * plus any app-model fields flagged `acl: true` in the application schema.
 *
 * Values are JSON-encoded on write and JSON-parsed on read, so a value
 * round-trips to its original type (number, string, boolean, object, array)
 * without the cache needing to know the model schema.
 *
 * Entries carry a short TTL and are treated as a CACHE, not a mirror: a miss
 * is expected and (in a later step) triggers a reload from the main database.
 * The Writer maintains entries on create / update / delete.
 */
export class NexxusModelFieldCache {
  /** Cache-key TTL. Deliberately short for a first cut; tune later. */
  private static readonly TTL_SECONDS = 600; // 10 minutes

  private readonly modelId: string;
  private readonly fields: Record<string, unknown>;

  constructor(modelId: string, fields: Record<string, unknown>) {
    this.modelId = modelId;
    this.fields = fields;
  }

  public static getKey(modelId: string): string {
    return `${NEXXUS_PREFIX_LC}:field-cache:${modelId}`;
  }

  /**
   * Persist the held fields into the HASH and (re)arm the TTL. `HSET` merges,
   * so this doubles as a write-through for a subset of fields — pass only the
   * fields that changed and the rest of the entry is left intact.
   */
  public async save(): Promise<void> {
    const entries = Object.entries(this.fields);

    if (entries.length === 0) {
      return;
    }

    const key = NexxusModelFieldCache.getKey(this.modelId);
    const encoded: Record<string, string> = {};

    for (const [field, value] of entries) {
      encoded[field] = JSON.stringify(value);
    }

    const redis = NexxusRedis.instance.getClient();

    await redis.hSet(key, encoded);
    await redis.expire(key, NexxusModelFieldCache.TTL_SECONDS);
  }

  /**
   * Read cached fields for an object. With `fields` omitted, returns the whole
   * cached projection; otherwise only the requested fields. Returns `null` when
   * nothing is cached (missing key / expired). Individual fields that aren't
   * present are simply omitted from the result — the caller distinguishes
   * "field absent" from a genuine cached value.
   */
  public static async get(
    modelId: string,
    fields?: Array<string>
  ): Promise<Record<string, unknown> | null> {
    const redis = NexxusRedis.instance.getClient();
    const key = NexxusModelFieldCache.getKey(modelId);
    const out: Record<string, unknown> = {};

    if (fields && fields.length > 0) {
      const values = await redis.hmGet(key, fields);

      fields.forEach((field, i) => {
        const raw = values[i];

        if (raw !== null && raw !== undefined) {
          out[field] = JSON.parse(raw as string);
        }
      });
    } else {
      const all = await redis.hGetAll(key);

      for (const [field, raw] of Object.entries(all)) {
        out[field] = JSON.parse(raw as string);
      }
    }

    return Object.keys(out).length === 0 ? null : out;
  }

  /** Delete the whole cache entry for an object (e.g. on object deletion). */
  public static async remove(modelId: string): Promise<void> {
    await NexxusRedis.instance.getClient().unlink(NexxusModelFieldCache.getKey(modelId));
  }
}
