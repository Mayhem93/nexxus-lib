/**
 * Ordered manifest for the `core` package's unit suites. Vitest runs the
 * imported suites' describe/it blocks in import order, so this file lists them
 * bottom-up (base constructs first, then the code that builds on them). Only
 * these per-package `index.test.ts` files are collected (see `include` in
 * vitest.config.ts); the suites themselves are plain `.ts` modules.
 */
import './AclStatement';
import './BuiltinSchemas';
import './SchemaValidator';
import './BaseModel';
import './FilterQuery';
import './JsonPatch';
import './Application';
import './AppModel';
import './User';
import './Setting';
import './AclStatementValidator';
import './AclConditionResolver';
import './AclRole';
import './Acl';
import './ConfigProvider';
import './ServiceResolver';
import './BaseService';
import './Logger';
import './ManagementServer';
import './HubClient';
import './ConfigManager';
