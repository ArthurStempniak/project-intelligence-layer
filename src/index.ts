/** Superficie publica do core. CLI e futuro servidor consomem apenas daqui. */
export * from './core/types/index.js';
export * from './core/ids.js';
export * from './core/text.js';
export * from './core/errors.js';
export * from './core/config/schema.js';
export type { Storage, IndexStats, LexicalHit, NeighborQuery, NeighborResult } from './storage/storage.js';
export { SqliteStorage } from './storage/sqlite/sqlite-storage.js';
