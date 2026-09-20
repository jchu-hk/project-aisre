/**
 * query/index.ts —— incident 查询 API 聚合（Issue #372，DESIGN §12.2）
 *
 * 供 main.ts 一行接入只读 incident 查询端点（见 reader.ts 纯读路径 + http.ts HTTP 接线）。
 */

export * from './types';
export { listIncidents, getIncidentDetail } from './reader';
export type { ReaderOpts } from './reader';
export { buildQueryHandle, QUERY_PATH } from './http';
export type { QueryDeps, QueryHandle } from './http';
