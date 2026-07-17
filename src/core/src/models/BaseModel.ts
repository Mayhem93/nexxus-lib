import type { NexxusApplication, INexxusApplication } from "./Application";
import type { NexxusUser, INexxusUser } from "./User";
import type { NexxusSetting, INexxusSetting } from "./Setting";
import type { NexxusAppModel, INexxusAppModel } from "./AppModel";

import { randomUUID } from "node:crypto"

export const MODEL_REGISTRY = {
  application: 'application',
  user: 'user',
  setting: 'setting'
} as const;

export type NexxusBuiltinTypeName = typeof MODEL_REGISTRY[keyof typeof MODEL_REGISTRY];
export type NexxusModelTypeName = NexxusBuiltinTypeName | (string & {});

export interface INexxusBaseModel<TType extends NexxusModelTypeName = NexxusModelTypeName> {
  id?: string;
  createdAt?: number;
  updatedAt?: number;
  type: TType;
}

export abstract class NexxusBaseModel<T extends INexxusBaseModel = INexxusBaseModel> {
  protected data: T;

  public static readonly modelType: string | undefined;

  constructor(data: T) {
    this.data = data;

    if (!this.data.type) {
      throw new Error("Model 'type' is required");
    }

    const now = Math.floor(Date.now()/1000);

    if (this.data.id === undefined) {
      this.data.id = randomUUID();
    }

    if (this.data.createdAt === undefined) {
      this.data.createdAt = now;
    }

    if (this.data.updatedAt === undefined) {
      this.data.updatedAt = now;
    }
  }

  getData(): T {
    return this.data;
  }
}

export type AnyNexxusBuiltinModel     = NexxusApplication | NexxusUser | NexxusSetting;
export type AnyNexxusBuiltinModelData = INexxusApplication | INexxusUser | INexxusSetting;
export type AnyNexxusModel            = AnyNexxusBuiltinModel | NexxusAppModel;
export type AnyNexxusModelData        = AnyNexxusBuiltinModelData | INexxusAppModel;
