/**
 * src/types/node-sqlite.d.ts —— node:sqlite 最小类型声明（Node ≥22 内建，实验特性）
 *
 * 运行环境 Node ≥22 已内建 node:sqlite，但 @types/node@20 未含其声明。
 * 此处提供本模块实际用到的最小接口，避免引入额外依赖（依赖仅 js-yaml）。
 */

declare module 'node:sqlite' {
  export interface StatementSync {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Array<Record<string, unknown>>;
  }
  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
