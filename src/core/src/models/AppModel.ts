import { NexxusApplicationSchema } from "./Application";
import { NexxusBaseModel, INexxusBaseModel } from "./BaseModel";
import { NexxusSchemaValidator } from "../common/SchemaValidator";
import { InvalidSchemaDataException } from "../lib/Exceptions";

export interface INexxusAppModel extends INexxusBaseModel {
  appId: string;
  userId?: string;
  /**
   * Monotonically-increasing per-document version counter, assigned by the
   * database adapter on every write. Used for client-side gap detection and
   * dedup when applying real-time update events. App models flow through the
   * async Writer → Transport Manager → client pipeline; built-in models
   * (Application, User) do not and therefore do not carry a version.
   * Never set by user input — the validator rejects user-supplied values.
   */
  version?: number;
  [key: string]: unknown;
}

export class NexxusAppModel extends NexxusBaseModel<INexxusAppModel> {
  /**
   * Construct an AppModel from user-supplied or pre-validated data.
   *
   * Pass the application's schema as the second argument to validate + normalize
   * the input (e.g. date strings → integer timestamps). Pass `null` to skip
   * validation — only do that when the data is already trusted (e.g. coming
   * back from storage). The `fromStorage` static factory below is the preferred
   * way to express that intent.
   */
  constructor(props: INexxusAppModel, appSchema: NexxusApplicationSchema | null) {
    if (!props.appId) {
      throw new Error('AppModel requires AppId');
    }

    if (appSchema === null) {
      // Trusted path — caller asserts the data is already validated
      // (e.g. it just came back from a database read).
      super(props);

      return;
    }

    const modelDef = appSchema[props.type];

    if (!modelDef) {
      throw new InvalidSchemaDataException(`Unknown app model type "${props.type}" for app "${props.appId}"`);
    }

    // Validates field types and normalizes values (notably: date strings/numeric
    // strings become integer timestamps so ES stores consistent types).
    // Required-field checking is intentionally deferred for now — only fields
    // present in `props` are validated.
    const normalized = NexxusSchemaValidator.validateAgainstSchema(
      props as Record<string, unknown>,
      modelDef.fields
    );

    super(normalized as INexxusAppModel);
  }

  /**
   * Hydrate an AppModel from already-validated storage. Use when reading back
   * from the database — the data was validated when it was written, so we don't
   * re-validate (saves work and avoids false-positives on legacy/edge-case docs
   * that pre-date a later schema change).
   */
  public static fromStorage(props: INexxusAppModel): NexxusAppModel {
    return new NexxusAppModel(props, null);
  }
}
