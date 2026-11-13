import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

type Param = SQLInputValue | undefined | boolean

const norm = (p: Param[]): SQLInputValue[] =>
  p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v))

/**
 * Thin wrapper over the built-in node:sqlite driver, kept behind this interface so it
 * can be swapped for better-sqlite3 without touching callers.
 */
export class Sql {
  readonly db: DatabaseSync

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;')
  }

  exec(sql: string) {
    this.db.exec(sql)
  }

  run(sql: string, ...p: Param[]) {
    return this.db.prepare(sql).run(...norm(p))
  }

  get<T>(sql: string, ...p: Param[]): T | undefined {
    return this.db.prepare(sql).get(...norm(p)) as T | undefined
  }

  all<T>(sql: string, ...p: Param[]): T[] {
    return this.db.prepare(sql).all(...norm(p)) as T[]
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const r = fn()
      this.db.exec('COMMIT')
      return r
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  close() {
    this.db.close()
  }
}
