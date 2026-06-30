import { NexxusException } from "@mayhem93/nexxus-core-lib";

enum NexxusDatabaseExceptions {
  DB_UPDATE_CONFLICT = "DatabaseUpdateConflictException"
};

export class NexxusDatabaseException extends NexxusException {
  constructor(name: string, message: string) {
    super(name, message);
  }
}

type DbUpdateConflictAttrs = {
  id: string,
  appId: string | null
};

export class NexxusDatabaseUpdateConflictException extends NexxusDatabaseException {
  public readonly id : string;
  public readonly appId: string | null;

  constructor(message: string, attrs: DbUpdateConflictAttrs) {
    super(NexxusDatabaseExceptions.DB_UPDATE_CONFLICT, message);

    this.id = attrs.id;
    this.appId = attrs.appId;
  }
}
