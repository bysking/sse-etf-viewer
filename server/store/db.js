// SQLite 初始化。使用 Node 内置 node:sqlite（Node >= 22.5），不引入原生依赖。
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCHEMA = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')

let singleton = null

/** 打开一个独立数据库（测试可传 ':memory:'） */
export function openDatabase(file = ':memory:') {
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA foreign_keys = ON;')
  } catch {
    /* :memory: 等场景下 PRAGMA 可能不支持，忽略 */
  }
  db.exec(SCHEMA)
  return db
}

/** 应用级单例：数据放在 data/app.db（可用 DATA_DIR 覆盖） */
export function getDb() {
  if (singleton) return singleton
  const dir = process.env.DATA_DIR || path.join(ROOT, 'data')
  fs.mkdirSync(dir, { recursive: true })
  singleton = openDatabase(path.join(dir, 'app.db'))
  return singleton
}

export function closeDb() {
  if (!singleton) return
  try {
    singleton.close()
  } finally {
    singleton = null
  }
}
