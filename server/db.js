import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './paths.js';

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS categories (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL UNIQUE,
  sort     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menu_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  price        INTEGER NOT NULL,
  image        TEXT NOT NULL DEFAULT '',
  available    INTEGER NOT NULL DEFAULT 1,
  sort         INTEGER NOT NULL DEFAULT 0
);

-- 選項群組：例如「湯/乾」「換麵」「加麵」，可掛在多個品項上共用
CREATE TABLE IF NOT EXISTS option_groups (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  key      TEXT NOT NULL UNIQUE,            -- 程式用代號，例如「湯乾」
  name     TEXT NOT NULL,                   -- 顯示給客人看的標題
  mode     TEXT NOT NULL DEFAULT 'single',  -- single=擇一 | multi=可複選
  required INTEGER NOT NULL DEFAULT 0,
  sort     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS option_choices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    INTEGER NOT NULL REFERENCES option_groups(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  price_delta INTEGER NOT NULL DEFAULT 0,
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS item_option_groups (
  item_id  INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES option_groups(id) ON DELETE CASCADE,
  sort     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, group_id)
);

CREATE TABLE IF NOT EXISTS tables (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  seats  INTEGER NOT NULL DEFAULT 4
);

-- 一次「入座到結帳」為一個 session，帳單以 session 結算
CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id   INTEGER NOT NULL REFERENCES tables(id),
  opened_at  TEXT NOT NULL,
  closed_at  TEXT,
  paid_total INTEGER,
  payment    TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  table_id   INTEGER NOT NULL REFERENCES tables(id),
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | preparing | done | cancelled
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id  INTEGER,
  name     TEXT NOT NULL,
  price    INTEGER NOT NULL,          -- 單價（已含選項加價）
  qty      INTEGER NOT NULL,
  note     TEXT NOT NULL DEFAULT '',
  options  TEXT NOT NULL DEFAULT '[]' -- 選項快照 [{group,name,price_delta}]
);

CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(session_id);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);
CREATE INDEX IF NOT EXISTS idx_items_order    ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_menu_category  ON menu_items(category_id);
`);

// 舊資料庫補欄位（新版加了選項功能）
const orderItemCols = db.prepare('PRAGMA table_info(order_items)').all().map((c) => c.name);
if (!orderItemCols.includes('options')) {
  db.exec("ALTER TABLE order_items ADD COLUMN options TEXT NOT NULL DEFAULT '[]'");
}

// 桌號 1-10
const tableCount = db.prepare('SELECT COUNT(*) AS n FROM tables').get().n;
if (tableCount === 0) {
  const ins = db.prepare('INSERT INTO tables (id, name, seats) VALUES (?, ?, ?)');
  for (let i = 1; i <= 10; i++) ins.run(i, `${i} 號桌`, 4);
}

export function now() {
  return new Date().toISOString();
}
