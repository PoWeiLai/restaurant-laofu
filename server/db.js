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

-- 內用單掛在桌次 session 底下；外帶單沒有桌號也沒有 session，兩個欄位都是 NULL
CREATE TABLE IF NOT EXISTS orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL DEFAULT 'dine_in',  -- dine_in=內用 | takeout=外帶自取
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  table_id   INTEGER REFERENCES tables(id),
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | preparing | done | cancelled
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  -- 以下只有外帶單會填
  pickup_no      TEXT NOT NULL DEFAULT '',  -- 取餐號，當天唯一，客人到店報這個號碼
  track_code     TEXT NOT NULL DEFAULT '',  -- 查詢碼，客人用它看自己這張單的進度
  customer_name  TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  pickup_at      TEXT NOT NULL DEFAULT '',  -- 預約取餐時間（HH:MM），空字串=盡快
  paid_at        TEXT,                      -- 外帶單各自收款，不走桌次帳單
  payment        TEXT
);

-- 店家自己的資料（店名、電話…），一列一個設定，讓店家在後台改而不必動程式
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
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

// 舊資料庫升級到外帶版本。
// 外帶單沒有桌號，但舊 schema 的 session_id / table_id 是 NOT NULL；SQLite 的 ALTER TABLE
// 改不掉 NOT NULL，只能照官方建議整張表重建再把資料搬過去。
const orderCols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
if (!orderCols.includes('type')) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  db.exec(`
    CREATE TABLE orders_new (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT NOT NULL DEFAULT 'dine_in',
      session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
      table_id   INTEGER REFERENCES tables(id),
      status     TEXT NOT NULL DEFAULT 'pending',
      note       TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      pickup_no      TEXT NOT NULL DEFAULT '',
      track_code     TEXT NOT NULL DEFAULT '',
      customer_name  TEXT NOT NULL DEFAULT '',
      customer_phone TEXT NOT NULL DEFAULT '',
      pickup_at      TEXT NOT NULL DEFAULT '',
      paid_at        TEXT,
      payment        TEXT
    );
    INSERT INTO orders_new (id, type, session_id, table_id, status, note, created_at)
      SELECT id, 'dine_in', session_id, table_id, status, note, created_at FROM orders;
    DROP TABLE orders;
    ALTER TABLE orders_new RENAME TO orders;
    CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(session_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);
  `);
  db.exec('COMMIT');
  db.exec('PRAGMA foreign_keys = ON');
  console.log('  資料庫已升級：訂單表新增外帶欄位');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_track ON orders(track_code)');

// 折扣與免單。
// 這些欄位都有預設值，直接 ADD COLUMN 就行，不必像外帶那次整張表重建。
//
// 兩個層級：
//   單項免單 — 客訴補一碗、做壞了重做，那一項不收錢，但仍要留在單子上讓老闆看得到
//   整單折扣 — 熟客打折、折抵定額、整桌招待
// 折扣「值」一律存「折讓的百分比或金額」（percent=10 表示折掉一成，也就是打 9 折），
// 不存折數，免得 9 折到底是折 9% 還是收 90% 每次都要想一次。
const addColumn = (table, col, decl) => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
};

addColumn('order_items', 'voided', 'INTEGER NOT NULL DEFAULT 0');
addColumn('order_items', 'void_reason', "TEXT NOT NULL DEFAULT ''");

for (const t of ['sessions', 'orders']) {
  // none | percent（折讓成數）| amount（折抵定額）| free（整單免單）
  addColumn(t, 'discount_type', "TEXT NOT NULL DEFAULT 'none'");
  addColumn(t, 'discount_value', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(t, 'discount_reason', "TEXT NOT NULL DEFAULT ''");
}
// 結帳時把當下折讓多少錢一起記下來，日後改了折扣設定也不影響已結的帳
addColumn('sessions', 'discount_total', 'INTEGER NOT NULL DEFAULT 0');
addColumn('orders', 'discount_total', 'INTEGER NOT NULL DEFAULT 0');

// 桌號 1-10
const tableCount = db.prepare('SELECT COUNT(*) AS n FROM tables').get().n;
if (tableCount === 0) {
  const ins = db.prepare('INSERT INTO tables (id, name, seats) VALUES (?, ?, ?)');
  for (let i = 1; i <= 10; i++) ins.run(i, `${i} 號桌`, 4);
}

export function now() {
  return new Date().toISOString();
}

/* ---------- 店家設定 ---------- */
// 店名、電話這些每家店都不一樣的資料放資料庫，讓店家在後台自己填。
// 寫死在程式裡的話，換一家店試用就得改程式重新部署一次。
export const SETTING_DEFAULTS = {
  shop_name: '好味牛肉麵',
  shop_phone: '02-1234-5678',
  shop_address: '新北市示範區美食路88號',
  takeout_enabled: '1', // 外帶／遠端訂餐開關，店家忙不過來時可以關掉
  takeout_lead_minutes: '20', // 最快多久可以取餐，用來算預約時間的最早選項
  // 外帶怕客人放鴿子：開這個，單子會先停在「待接單」等店員確認，確認後才進廚房
  takeout_confirm_first: '0',
  // 外帶是否開放線上先付款（關掉就只能到店付款）
  payment_online: '0',
  // mock = 示範用的模擬付款，按下去就當作成功，不會真的收錢；
  // 要真的收錢得接金流（綠界／藍新／LINE Pay），見 server/index.js 的 pay-online
  payment_provider: 'mock',
};

const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(SETTING_DEFAULTS)) insSetting.run(key, value);

export function getSettings() {
  const saved = db.prepare('SELECT key, value FROM settings').all();
  return { ...SETTING_DEFAULTS, ...Object.fromEntries(saved.map((r) => [r.key, r.value])) };
}

/** 只接受認得的設定鍵，避免前端亂塞東西進資料庫 */
export function saveSettings(patch) {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [key, value] of Object.entries(patch || {})) {
    if (key in SETTING_DEFAULTS && value != null) stmt.run(key, String(value).trim());
  }
  return getSettings();
}
