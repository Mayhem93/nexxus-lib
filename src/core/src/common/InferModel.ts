// Type-level inference from a NexxusModelDef literal (declared `as const`)
// to the corresponding TypeScript object shape.

export type InferFieldDef<D> =
  D extends { type: 'string' }  ? string  :
  D extends { type: 'number' }  ? number  :
  D extends { type: 'boolean' } ? boolean :
  D extends { type: 'date' }    ? number  :
  D extends { type: 'array', arrayType: infer AT, properties?: infer P } ?
    AT extends 'object'
      ? P extends Record<string, any> ? Array<InferModel<P>> : never
      : AT extends 'string'  ? string[]
      : AT extends 'number'  ? number[]
      : AT extends 'boolean' ? boolean[]
      : AT extends 'date'    ? number[]
      : never :
  D extends { type: 'object', properties: infer P } ?
    P extends Record<string, any> ? InferModel<P> : never :
  never;

type ApplyNullable<D, T> = D extends { nullable: true } ? T | null : T;

export type InferModel<S> =
  & { -readonly [K in keyof S as S[K] extends { required: true } ? K : never]:
        ApplyNullable<S[K], InferFieldDef<S[K]>> }
  & { -readonly [K in keyof S as S[K] extends { required: true } ? never : K]?:
        ApplyNullable<S[K], InferFieldDef<S[K]>> };
