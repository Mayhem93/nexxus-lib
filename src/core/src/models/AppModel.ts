import { NexxusBaseModel, INexxusBaseModel } from "./BaseModel";

export interface INexxusAppModel extends INexxusBaseModel {
  appId: string;
  userId?: string;
  [key: string]: any;
}

export class NexxusAppModel extends NexxusBaseModel<INexxusAppModel> {
  constructor(props: INexxusAppModel) {
    super(props);

    // Validate required field
    if (!props.appId) {
      throw new Error('AppModel requires AppId');
    }
  }
}
