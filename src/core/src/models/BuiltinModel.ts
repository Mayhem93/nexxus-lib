import {
  NexxusBaseModel,
  INexxusBaseModel,
  NexxusBuiltinTypeName
} from "./BaseModel";

export abstract class NexxusBuiltinModel<
  T extends INexxusBaseModel<NexxusBuiltinTypeName>
> extends NexxusBaseModel<T> {}
