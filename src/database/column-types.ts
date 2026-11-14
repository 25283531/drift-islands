import { config } from 'dotenv';

config();

/**
 * 同一套实体同时跑本地 SQLite（开发 / 测试）与 PostgreSQL（测试 / 生产）。
 * 实体装饰器在模块加载时求值，因此这里直接读环境变量，不做运行时切换。
 */
export const IS_POSTGRES = (process.env.DB_TYPE ?? 'sqlite').toLowerCase() === 'postgres';

export const ID_TYPE: any = IS_POSTGRES ? 'uuid' : 'varchar';
export const JSON_TYPE: any = IS_POSTGRES ? 'jsonb' : 'simple-json';
export const TIMESTAMP_TYPE: any = IS_POSTGRES ? 'timestamptz' : 'datetime';
export const FLOAT_TYPE: any = IS_POSTGRES ? 'double precision' : 'real';
export const TEXT_TYPE: any = 'text';
export const INT_TYPE: any = 'integer';
export const BOOL_TYPE: any = IS_POSTGRES ? 'boolean' : 'boolean';
export const DATE_TYPE: any = IS_POSTGRES ? 'date' : 'date';
