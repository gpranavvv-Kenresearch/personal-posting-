/**
 * node-sqlite.d.ts — minimal ambient types for Node's built-in `node:sqlite`.
 *
 * WHY THIS FILE EXISTS
 * The intelligence store (src/intelligence/db.ts) uses Node's built-in
 * `node:sqlite` (Node 22.5+) precisely so that NO new npm dependency and no
 * native build step are needed. This repo pins `@types/node@^20`, which predates
 * `node:sqlite` and therefore ships no declarations for it, so `tsc --noEmit`
 * reported TS2307 "Cannot find module 'node:sqlite'".
 *
 * This declares only the surface db.ts actually uses. It is NOT a dependency —
 * it is a type-only shim. When @types/node is upgraded to a version that ships
 * `node:sqlite` declarations, delete this file.
 */

declare module 'node:sqlite' {
  export type SQLInputValue =
    | null
    | number
    | bigint
    | string
    | Uint8Array;

  export type SQLOutputValue =
    | null
    | number
    | bigint
    | string
    | Uint8Array;

  export interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    run(...params: SQLInputValue[]): StatementResultingChanges;
    get(...params: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
    all(...params: SQLInputValue[]): Record<string, SQLOutputValue>[];
    iterate(...params: SQLInputValue[]): IterableIterator<Record<string, SQLOutputValue>>;
    columns(): Array<Record<string, string | null>>;
    expandedSQL: string;
    sourceSQL: string;
    setAllowBareNamedParameters(enabled: boolean): void;
    setReadBigInts(enabled: boolean): void;
  }

  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
    allowExtension?: boolean;
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    open(): void;
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    readonly isOpen: boolean;
  }

  export function backup(
    source: DatabaseSync,
    destination: string,
    options?: Record<string, unknown>,
  ): Promise<number>;
}
