import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getSettings, now, saveSettings } from './db.js';
import { DATA_DIR, IMAGES_DIR } from './paths.js';
import { seedMenu } from './seed.js';
import { sseHandler, broadcast } from './events.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = Number(process.env.PORT || 3001);
const STAFF_PIN = String(process.env.STAFF_PIN || '1234');

// 全新部署時資料庫是空的，先把內建菜單灌進去，免得店家打開看到一片空白
if (db.prepare('SELECT COUNT(*) AS n FROM menu_items').get().n === 0) {
  const r = seedMenu();
  console.log(`  首次啟動，已匯入內建菜單：${r.categories} 個分類、${r.items} 道菜`);
}

const app = express();
app.use(express.json({ limit: '1mb' }));

/* ---------- 保溫用健康檢查 ---------- */
// Render 免費方案 15 分鐘沒流量就休眠，之後第一位客人要等約 50 秒才看得到畫面。
// 用外部排程（例如 cron-job.org）每 10 分鐘打這支，服務就不會睡著。
// 刻意不碰資料庫也不查任何東西，讓它又快又不吃資源。
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

/* ---------- 工具 ---------- */
// WSL / Hyper-V / VirtualBox 之類的虛擬網卡，手機連不到，要排除
const VIRTUAL_ADAPTER = /vEthernet|WSL|Hyper-?V|VirtualBox|VMware|Docker|Loopback|Bluetooth|藍牙/i;

/** 找出客人手機真正連得到的區網 IP（優先家用/店用網段） */
function lanIP() {
  const candidates = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_ADAPTER.test(name)) continue;
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (net.address.startsWith('169.254.')) continue; // 沒拿到 DHCP 的自動私有位址
      candidates.push({ name, address: net.address });
    }
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  candidates.sort((a, b) => rank(a.address) - rank(b.address));
  return candidates[0]?.address || 'localhost';
}
// PUBLIC_URL 手動指定 > 雲端平台自動提供的網址 > 本機區網 IP
const baseURL = () =>
  process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://${lanIP()}:${PORT}`;

// 店員身分（廚房 / 後台）：內網用共用 PIN 即可
function staffOnly(req, res, next) {
  if (req.get('x-staff-pin') === STAFF_PIN) return next();
  res.status(401).json({ error: '未授權，請輸入正確店員密碼' });
}

const ok = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const bad = (res, msg) => res.status(400).json({ error: msg });

/* ---------- 試用期 ---------- */
// 要給店家試用 7 天，就在部署時設 TRIAL_UNTIL=2026-09-19（最後一天，含當天）。
// 到期後客人端停止下單，但店員照樣能登入後台看資料、下載備份，不會把店家鎖在門外。
// 不設這個變數就是完整版，沒有任何期限。
const TRIAL_UNTIL = String(process.env.TRIAL_UNTIL || '').trim();

function trialInfo() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(TRIAL_UNTIL)) return null;
  // 店家在台灣，用 +08:00 算到當天營業結束，避免伺服器在新加坡卻提早一天到期
  const endsAt = new Date(`${TRIAL_UNTIL}T23:59:59+08:00`).getTime();
  const msLeft = endsAt - Date.now();
  return {
    until: TRIAL_UNTIL,
    daysLeft: Math.max(0, Math.ceil(msLeft / 86400000)),
    expired: msLeft <= 0,
  };
}

/* ---------- 外帶單編號 ---------- */
/** 取餐號：每天從 001 重新開始，客人到店報這個號碼 */
function nextPickupNo() {
  const n = db
    .prepare(
      "SELECT COUNT(*) AS n FROM orders WHERE type = 'takeout' AND date(created_at,'localtime') = date('now','localtime')"
    )
    .get().n;
  return String(n + 1).padStart(3, '0');
}
/** 查詢碼：取餐號每天重複，不能拿來當查訂單的網址，另外給一組猜不到的碼 */
const newTrackCode = () => randomBytes(5).toString('hex');

function itemsOf(orderId) {
  return db
    .prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id')
    .all(orderId)
    .map((i) => ({ ...i, options: JSON.parse(i.options || '[]') }));
}

/** 某品項掛的選項群組（含選擇項） */
function optionGroupsOf(itemId) {
  const groups = db
    .prepare(
      `SELECT g.* FROM option_groups g
       JOIN item_option_groups m ON m.group_id = g.id
       WHERE m.item_id = ? ORDER BY m.sort, g.id`
    )
    .all(itemId);
  const choices = db.prepare('SELECT * FROM option_choices WHERE group_id = ? ORDER BY sort, id');
  return groups.map((g) => ({ ...g, choices: choices.all(g.id) }));
}
function withItems(orders) {
  return orders.map((o) => {
    const items = itemsOf(o.id);
    return { ...o, items, total: items.reduce((s, i) => s + i.price * i.qty, 0) };
  });
}
// 取得該桌目前未結帳的 session，沒有就開一個
function openSession(tableId) {
  const found = db
    .prepare('SELECT * FROM sessions WHERE table_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(tableId);
  if (found) return found;
  const id = db.prepare('INSERT INTO sessions (table_id, opened_at) VALUES (?, ?)').run(tableId, now())
    .lastInsertRowid;
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

/* ---------- 客人端 ---------- */
app.get('/api/events', sseHandler);

// 店名、電話、外帶開不開、試用還剩幾天——前端每頁都要，公開不需登入
app.get('/api/shop', (_req, res) => {
  const s = getSettings();
  res.json({
    name: s.shop_name,
    phone: s.shop_phone,
    address: s.shop_address,
    takeoutEnabled: s.takeout_enabled === '1',
    takeoutLeadMinutes: Number(s.takeout_lead_minutes) || 20,
    paymentOnline: s.payment_online === '1',
    paymentProvider: s.payment_provider,
    trial: trialInfo(),
  });
});

app.get('/api/menu', (_req, res) => {
  const cats = db.prepare('SELECT * FROM categories ORDER BY sort, id').all();
  const stmt = db.prepare('SELECT * FROM menu_items WHERE category_id = ? ORDER BY sort, id');
  res.json(
    cats.map((c) => ({
      ...c,
      items: stmt.all(c.id).map((i) => ({ ...i, optionGroups: optionGroupsOf(i.id) })),
    }))
  );
});

app.get('/api/tables', (_req, res) => {
  res.json(db.prepare('SELECT * FROM tables ORDER BY id').all());
});

// 該桌本次用餐的所有訂單（客人可查自己點了什麼、進度到哪）
app.get('/api/tables/:id/session', (req, res) => {
  const tableId = Number(req.params.id);
  const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(tableId);
  if (!table) return res.status(404).json({ error: '查無此桌號' });

  const session = db
    .prepare('SELECT * FROM sessions WHERE table_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(tableId);
  if (!session) return res.json({ table, session: null, orders: [], total: 0 });

  const orders = withItems(
    db.prepare("SELECT * FROM orders WHERE session_id = ? AND status <> 'cancelled' ORDER BY id").all(session.id)
  );
  res.json({ table, session, orders, total: orders.reduce((s, o) => s + o.total, 0) });
});

// 送出訂單（內用掃桌號，外帶/遠端訂餐不需要桌號）
app.post('/api/orders', (req, res) => {
  const { type = 'dine_in', tableId, items, note = '', customer = {}, pickupAt = '' } = req.body || {};
  const takeout = type === 'takeout';

  const trial = trialInfo();
  if (trial?.expired) {
    return res.status(403).json({ error: '試用期已結束，目前暫停接單。' });
  }

  let table = null;
  if (takeout) {
    if (getSettings().takeout_enabled !== '1') return bad(res, '本店目前暫停外帶接單，敬請見諒');
    if (!ok(customer.name)) return bad(res, '請填寫取餐人姓名');
    if (!/^[0-9+\-() ]{8,20}$/.test(String(customer.phone || '').trim())) {
      return bad(res, '請填寫正確的連絡電話');
    }
    // 空字串代表「盡快取餐」，有填就必須是 HH:MM
    if (pickupAt !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(pickupAt))) {
      return bad(res, '取餐時間格式不正確');
    }
  } else {
    table = db.prepare('SELECT * FROM tables WHERE id = ?').get(Number(tableId));
    if (!table) return bad(res, '桌號不存在');
  }
  if (!Array.isArray(items) || items.length === 0) return bad(res, '購物車是空的');

  const lookup = db.prepare('SELECT * FROM menu_items WHERE id = ?');
  const rows = [];
  for (const line of items) {
    const menuItem = lookup.get(Number(line.itemId));
    if (!menuItem) return bad(res, `品項不存在（id ${line.itemId}）`);
    if (!menuItem.available) return bad(res, `「${menuItem.name}」已售完，請重新選擇`);
    const qty = Math.max(1, Math.min(99, Math.round(Number(line.qty) || 1)));

    // 選項驗證：只接受掛在這道菜底下的選擇，加價由伺服器算，前端傳來的價格一律不採信
    const groups = optionGroupsOf(menuItem.id);
    const picked = Array.isArray(line.choiceIds) ? line.choiceIds.map(Number) : [];
    const chosen = [];
    for (const group of groups) {
      const hits = group.choices.filter((c) => picked.includes(c.id));
      if (group.mode === 'single' && hits.length > 1) {
        return bad(res, `「${menuItem.name}」的「${group.name}」只能選一項`);
      }
      if (group.required && hits.length === 0) {
        return bad(res, `「${menuItem.name}」請選擇「${group.name}」`);
      }
      for (const c of hits) chosen.push({ group: group.name, name: c.name, price_delta: c.price_delta });
    }
    const validIds = new Set(groups.flatMap((g) => g.choices.map((c) => c.id)));
    if (picked.some((id) => !validIds.has(id))) {
      return bad(res, `「${menuItem.name}」有不合法的選項`);
    }

    // 價格與品名當下快照，之後改價不影響已送出的單
    const unitPrice = menuItem.price + chosen.reduce((s, c) => s + c.price_delta, 0);
    rows.push({
      id: menuItem.id,
      name: menuItem.name,
      price: unitPrice,
      qty,
      note: String(line.note || ''),
      options: chosen,
    });
  }

  let orderId;
  if (takeout) {
    // 開了「先確認再下廚」就停在 awaiting，店員按接單才會出現在廚房看板
    const initial = getSettings().takeout_confirm_first === '1' ? 'awaiting' : 'pending';
    orderId = db
      .prepare(
        `INSERT INTO orders (type, status, note, created_at, pickup_no, track_code, customer_name, customer_phone, pickup_at)
         VALUES ('takeout', ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        initial,
        String(note),
        now(),
        nextPickupNo(),
        newTrackCode(),
        String(customer.name).trim(),
        String(customer.phone).trim(),
        String(pickupAt)
      ).lastInsertRowid;
  } else {
    const session = openSession(table.id);
    orderId = db
      .prepare(
        "INSERT INTO orders (type, session_id, table_id, status, note, created_at) VALUES ('dine_in', ?, ?, 'pending', ?, ?)"
      )
      .run(session.id, table.id, String(note), now()).lastInsertRowid;
  }

  const insItem = db.prepare(
    'INSERT INTO order_items (order_id, item_id, name, price, qty, note, options) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const r of rows) insItem.run(orderId, r.id, r.name, r.price, r.qty, r.note, JSON.stringify(r.options));

  const order = withItems([db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)])[0];
  broadcast('order:new', order);
  res.status(201).json(order);
});

/* ---------- 外帶 / 遠端訂餐 ---------- */
// 客人用查詢碼追自己那張單的進度。取餐號每天重複，所以網址不能用取餐號。
app.get('/api/takeout/:code', (req, res) => {
  const order = db
    .prepare("SELECT * FROM orders WHERE type = 'takeout' AND track_code = ?")
    .get(String(req.params.code));
  if (!order) return res.status(404).json({ error: '查無此訂單' });
  res.json(withItems([order])[0]);
});

/**
 * 外帶線上付款。
 *
 * 目前只有 mock（示範用）：按下去就當作付款成功，不會真的跟客人收錢，
 * 用途是讓 demo 能把「線上付款 → 廚房 → 取餐」整條流程走完。
 *
 * 要真的收錢，在這裡接金流（綠界 ECPay / 藍新 / LINE Pay），流程會變成三步：
 *   1. 這支改成向金流商建立交易，回傳付款網址，前端把客人導過去
 *   2. 金流商付款完成後回呼一支新的 /api/payments/callback（要驗簽章）
 *   3. 驗章通過才在這裡寫 paid_at
 * 在那之前絕對不要因為前端說「付好了」就標記已付款——前端的話一律不能信。
 */
app.post('/api/takeout/:code/pay-online', (req, res) => {
  const order = db
    .prepare("SELECT * FROM orders WHERE type = 'takeout' AND track_code = ?")
    .get(String(req.params.code));
  if (!order) return res.status(404).json({ error: '查無此訂單' });
  if (order.paid_at) return bad(res, '這張單已經付過款了');

  const settings = getSettings();
  if (settings.payment_online !== '1') return bad(res, '本店目前未開放線上付款');
  if (settings.payment_provider !== 'mock') {
    return res.status(501).json({ error: '線上金流尚未設定完成，請改選到店付款' });
  }

  db.prepare('UPDATE orders SET paid_at = ?, payment = ? WHERE id = ?').run(now(), 'online', order.id);
  const updated = withItems([db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id)])[0];
  broadcast('order:update', updated);
  res.json(updated);
});

/* ---------- 廚房 ---------- */
// awaiting 只有外帶會用到：店家開了「先確認再下廚」時，單子停在這一關等店員接單
const STATUSES = ['awaiting', 'pending', 'preparing', 'done', 'cancelled'];

app.get('/api/kitchen/orders', staffOnly, (req, res) => {
  const all = req.query.scope === 'all';
  const sql = all
    ? "SELECT * FROM orders WHERE date(created_at,'localtime') = date('now','localtime') ORDER BY id DESC"
    : "SELECT * FROM orders WHERE status IN ('pending','preparing') ORDER BY id";
  res.json(withItems(db.prepare(sql).all()));
});

app.patch('/api/orders/:id/status', staffOnly, (req, res) => {
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) return bad(res, '狀態不合法');
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: '訂單不存在' });

  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, order.id);
  const updated = withItems([db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id)])[0];
  broadcast('order:update', updated);
  res.json(updated);
});

/* ---------- 店員登入 ---------- */
app.post('/api/staff/login', (req, res) => {
  if (String(req.body?.pin) === STAFF_PIN) return res.json({ ok: true });
  res.status(401).json({ error: '密碼錯誤' });
});

/* ---------- 後台：菜單 ---------- */
app.post('/api/admin/categories', staffOnly, (req, res) => {
  const { name, sort = 0 } = req.body || {};
  if (!ok(name)) return bad(res, '請輸入分類名稱');
  try {
    const id = db
      .prepare('INSERT INTO categories (name, sort) VALUES (?, ?)')
      .run(String(name).trim(), Number(sort) || 0).lastInsertRowid;
    broadcast('menu:update');
    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(id));
  } catch {
    bad(res, '分類名稱重複');
  }
});

app.patch('/api/admin/categories/:id', staffOnly, (req, res) => {
  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(req.params.id));
  if (!cat) return res.status(404).json({ error: '分類不存在' });
  const name = ok(req.body?.name) ? String(req.body.name).trim() : cat.name;
  const sort = req.body?.sort ?? cat.sort;
  db.prepare('UPDATE categories SET name = ?, sort = ? WHERE id = ?').run(name, Number(sort), cat.id);
  broadcast('menu:update');
  res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(cat.id));
});

app.delete('/api/admin/categories/:id', staffOnly, (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(Number(req.params.id));
  broadcast('menu:update');
  res.json({ ok: true });
});

app.post('/api/admin/menu-items', staffOnly, (req, res) => {
  const { categoryId, name, price, description = '', image = '', sort = 0 } = req.body || {};
  if (!ok(name)) return bad(res, '請輸入品名');
  if (!Number.isFinite(Number(price)) || Number(price) < 0) return bad(res, '價格不正確');
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(Number(categoryId))) return bad(res, '分類不存在');
  const id = db
    .prepare(
      'INSERT INTO menu_items (category_id, name, description, price, image, available, sort) VALUES (?, ?, ?, ?, ?, 1, ?)'
    )
    .run(
      Number(categoryId),
      String(name).trim(),
      String(description),
      Math.round(Number(price)),
      String(image),
      Number(sort) || 0
    ).lastInsertRowid;
  broadcast('menu:update');
  res.status(201).json(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id));
});

app.patch('/api/admin/menu-items/:id', staffOnly, (req, res) => {
  const it = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(Number(req.params.id));
  if (!it) return res.status(404).json({ error: '品項不存在' });
  const b = req.body || {};
  const next = {
    category_id: b.categoryId != null ? Number(b.categoryId) : it.category_id,
    name: ok(b.name) ? String(b.name).trim() : it.name,
    description: b.description != null ? String(b.description) : it.description,
    price: b.price != null ? Math.round(Number(b.price)) : it.price,
    image: b.image != null ? String(b.image) : it.image,
    available: b.available != null ? (b.available ? 1 : 0) : it.available,
    sort: b.sort != null ? Number(b.sort) : it.sort,
  };
  if (!Number.isFinite(next.price) || next.price < 0) return bad(res, '價格不正確');
  db.prepare(
    'UPDATE menu_items SET category_id=?, name=?, description=?, price=?, image=?, available=?, sort=? WHERE id=?'
  ).run(
    next.category_id,
    next.name,
    next.description,
    next.price,
    next.image,
    next.available,
    next.sort,
    it.id
  );
  broadcast('menu:update');
  res.json(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(it.id));
});

app.delete('/api/admin/menu-items/:id', staffOnly, (req, res) => {
  db.prepare('DELETE FROM menu_items WHERE id = ?').run(Number(req.params.id));
  broadcast('menu:update');
  res.json({ ok: true });
});

// 批次貼上匯入：每行「分類,品名,價格,描述(可省略)」
app.post('/api/admin/menu/bulk', staffOnly, (req, res) => {
  const { text = '', replace = false } = req.body || {};
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return bad(res, '沒有可匯入的內容');

  const parsed = [];
  for (const [i, line] of lines.entries()) {
    const [cat, name, price, desc = ''] = line.split(/[,，\t]/).map((p) => p.trim());
    if (!cat || !name || !Number.isFinite(Number(price))) {
      return bad(res, `第 ${i + 1} 行格式錯誤：${line}（需為 分類,品名,價格）`);
    }
    parsed.push({ cat, name, price: Math.round(Number(price)), desc });
  }

  if (replace) {
    db.exec('DELETE FROM menu_items');
    db.exec('DELETE FROM categories');
  }
  const findCat = db.prepare('SELECT * FROM categories WHERE name = ?');
  const insCat = db.prepare('INSERT INTO categories (name, sort) VALUES (?, ?)');
  const insItem = db.prepare(
    "INSERT INTO menu_items (category_id, name, description, price, image, available, sort) VALUES (?, ?, ?, ?, '', 1, ?)"
  );
  let count = 0;
  for (const row of parsed) {
    let cat = findCat.get(row.cat);
    if (!cat) {
      const id = insCat.run(row.cat, db.prepare('SELECT COUNT(*) AS n FROM categories').get().n).lastInsertRowid;
      cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    }
    const sort = db.prepare('SELECT COUNT(*) AS n FROM menu_items WHERE category_id = ?').get(cat.id).n;
    insItem.run(cat.id, row.name, row.desc, row.price, sort);
    count++;
  }
  broadcast('menu:update');
  res.json({ ok: true, count });
});

/* ---------- 後台：菜色照片上傳 ---------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: IMAGES_DIR,
    filename: (_req, file, cb) =>
      cb(
        null,
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extname(file.originalname).toLowerCase()}`
      ),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    /^image\/(png|jpe?g|webp|gif|avif)$/.test(file.mimetype) ? cb(null, true) : cb(new Error('只接受圖片檔')),
});

app.post('/api/admin/upload', staffOnly, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return bad(res, err.message);
    if (!req.file) return bad(res, '沒有收到檔案');
    res.status(201).json({ url: `/images/${req.file.filename}` });
  });
});

/* ---------- 後台：QRcode ---------- */
app.get('/api/admin/qrcodes', staffOnly, async (_req, res) => {
  const tables = db.prepare('SELECT * FROM tables ORDER BY id').all();
  const out = [];
  for (const t of tables) {
    const url = `${baseURL()}/t/${t.id}`;
    out.push({ ...t, url, qr: await QRCode.toDataURL(url, { width: 512, margin: 1 }) });
  }
  // 外帶專用 QRcode：貼在店門口或傳給客人，掃了直接開外帶點餐頁
  const takeoutUrl = `${baseURL()}/takeout`;
  res.json({
    baseURL: baseURL(),
    tables: out,
    takeout: { url: takeoutUrl, qr: await QRCode.toDataURL(takeoutUrl, { width: 512, margin: 1 }) },
  });
});

/* ---------- 後台：帳單 / 結帳 ---------- */
app.get('/api/admin/bills', staffOnly, (_req, res) => {
  const sessions = db.prepare('SELECT * FROM sessions WHERE closed_at IS NULL ORDER BY table_id').all();
  res.json(
    sessions.map((s) => {
      const orders = withItems(
        db.prepare("SELECT * FROM orders WHERE session_id = ? AND status <> 'cancelled' ORDER BY id").all(s.id)
      );
      const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(s.table_id);
      return { ...s, table, orders, total: orders.reduce((sum, o) => sum + o.total, 0) };
    })
  );
});

// 外帶單不掛在桌次底下，各自收款，所以獨立一張清單
app.get('/api/admin/takeout', staffOnly, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT * FROM orders
       WHERE type = 'takeout' AND date(created_at,'localtime') = date('now','localtime')
       ORDER BY id DESC`
    )
    .all();
  res.json(withItems(rows));
});

app.post('/api/admin/orders/:id/pay', staffOnly, (req, res) => {
  const order = db
    .prepare("SELECT * FROM orders WHERE id = ? AND type = 'takeout'")
    .get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: '外帶訂單不存在' });
  if (order.paid_at) return bad(res, '這張單已經收過款了');

  const payment = ['cash', 'card', 'mobile'].includes(req.body?.payment) ? req.body.payment : 'cash';
  db.prepare('UPDATE orders SET paid_at = ?, payment = ? WHERE id = ?').run(now(), payment, order.id);
  const updated = withItems([db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id)])[0];
  broadcast('order:update', updated);
  res.json(updated);
});

app.post('/api/admin/sessions/:id/close', staffOnly, (req, res) => {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: '帳單不存在' });
  if (s.closed_at) return bad(res, '此帳單已結清');

  const orders = withItems(
    db.prepare("SELECT * FROM orders WHERE session_id = ? AND status <> 'cancelled'").all(s.id)
  );
  const total = orders.reduce((sum, o) => sum + o.total, 0);
  const payment = ['cash', 'card', 'mobile'].includes(req.body?.payment) ? req.body.payment : 'cash';

  db.prepare('UPDATE sessions SET closed_at = ?, paid_total = ?, payment = ? WHERE id = ?').run(
    now(),
    total,
    payment,
    s.id
  );
  broadcast('bill:closed', { sessionId: s.id, tableId: s.table_id, total });
  res.json({ ok: true, total, payment });
});

// 今日營業摘要
app.get('/api/admin/report', staffOnly, (_req, res) => {
  const closed = db
    .prepare(
      "SELECT * FROM sessions WHERE closed_at IS NOT NULL AND date(closed_at,'localtime') = date('now','localtime')"
    )
    .all();
  const top = db
    .prepare(
      `SELECT oi.name AS name, SUM(oi.qty) AS qty, SUM(oi.qty * oi.price) AS amount
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE date(o.created_at,'localtime') = date('now','localtime') AND o.status <> 'cancelled'
       GROUP BY oi.name ORDER BY qty DESC LIMIT 10`
    )
    .all();
  // 外帶不走桌次帳單，營業額要另外加進來，否則老闆看到的數字是短少的
  const takeoutPaid = db
    .prepare(
      `SELECT o.id, SUM(oi.price * oi.qty) AS total
       FROM orders o JOIN order_items oi ON oi.order_id = o.id
       WHERE o.type = 'takeout' AND o.paid_at IS NOT NULL
         AND date(o.paid_at,'localtime') = date('now','localtime')
       GROUP BY o.id`
    )
    .all();

  res.json({
    closedCount: closed.length,
    takeoutCount: takeoutPaid.length,
    dineInRevenue: closed.reduce((s, c) => s + (c.paid_total || 0), 0),
    takeoutRevenue: takeoutPaid.reduce((s, o) => s + (o.total || 0), 0),
    revenue:
      closed.reduce((s, c) => s + (c.paid_total || 0), 0) +
      takeoutPaid.reduce((s, o) => s + (o.total || 0), 0),
    topItems: top,
  });
});

/* ---------- 後台：店家設定 ---------- */
// /api/shop 只給客人端需要的欄位，後台要看到全部（含還沒公開的開關）
app.get('/api/admin/settings', staffOnly, (_req, res) => {
  res.json(getSettings());
});

app.patch('/api/admin/settings', staffOnly, (req, res) => {
  const next = saveSettings(req.body);
  broadcast('shop:update');
  res.json(next);
});

/* ---------- 後台：下載備份 ---------- */
// 老闆自己按一下就能把整個資料庫存到他的電腦，不必找工程師。
// VACUUM INTO 會輸出一份乾淨且一致的複本，不受 WAL 尚未寫回影響。
app.get('/api/admin/backup', staffOnly, (_req, res) => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const tmp = join(DATA_DIR, `backup-${stamp}.db`);
  try {
    rmSync(tmp, { force: true });
    db.exec(`VACUUM INTO '${tmp.split("'").join("''")}'`);
  } catch (e) {
    return res.status(500).json({ error: `備份失敗：${e.message}` });
  }
  res.download(tmp, `restaurant-backup-${stamp}.db`, () => rmSync(tmp, { force: true }));
});

/* ---------- 前端靜態檔（正式模式） ---------- */
const DIST = join(ROOT, 'dist');
app.use('/images', express.static(IMAGES_DIR)); // 店家上傳的照片在永久儲存空間，優先
app.use(express.static(join(ROOT, 'public')));
// index: false 很重要：否則 static 會直接把 dist/index.html 當首頁送出去，
// 走不到下面填店名的那段，「/」的標題就會是沒有店名的後備文字。
//
// dist/assets 底下的檔名都帶內容雜湊（改了內容就換檔名），可以讓瀏覽器永久留著。
// 預設的 max-age=0 會讓客人每次開頁面都回來問一輪「這幾支檔案變了沒」，
// 對休眠中的免費主機來說每一趟都是額外等待。
app.use(
  '/assets',
  express.static(join(DIST, 'assets'), {
    immutable: true,
    maxAge: '1y',
  })
);
app.use(express.static(DIST, { index: false }));

/**
 * 把店名填進 index.html 的標題與連結預覽標籤。
 *
 * 為什麼不在前端用 JavaScript 改 document.title 就好：LINE、Facebook 這些的連結預覽爬蟲
 * 不會執行 JavaScript，只讀原始 HTML。店家把店名改掉之後，分享出去的連結若還顯示舊名字，
 * 對「拿這套 demo 給不同餐廳看」來說就是破綻。
 */
/** 連結預覽的縮圖：拿菜單第一張有照片的菜色，店家換了照片預覽就跟著換 */
function previewImage() {
  const row = db
    .prepare("SELECT image FROM menu_items WHERE image <> '' AND available = 1 ORDER BY sort, id LIMIT 1")
    .get();
  return row ? baseURL() + row.image : '';
}

function renderIndex(reqPath) {
  const s = getSettings();
  const title = `${s.shop_name} — 線上點餐`;
  const desc = reqPath.startsWith('/takeout')
    ? `${s.shop_name} 外帶線上訂餐：先點好、時間到再來拿，不用現場排隊。`
    : `${s.shop_name} 手機掃碼點餐`;

  const image = previewImage();
  // 沒有 og:image 的話，LINE 的預覽就只有乾乾的一行字，看起來不像一家店
  const extra =
    `  <meta property="og:site_name" content="${escapeHtml(s.shop_name)}" />\n` +
    `  <meta property="og:url" content="${escapeHtml(baseURL() + reqPath)}" />\n` +
    (image
      ? `  <meta property="og:image" content="${escapeHtml(image)}" />\n` +
        `  <meta name="twitter:card" content="summary_large_image" />\n`
      : '');

  return readFileSync(join(DIST, 'index.html'), 'utf8')
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace(
      /(<meta (?:name="description"|property="og:title"|property="og:description") content=")[^"]*(")/g,
      (_m, head, tail) => head + escapeHtml(head.includes('og:title') ? title : desc) + tail
    )
    .replace('</head>', `${extra}  </head>`);
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// SPA fallback：/kitchen、/admin、/t/3 等前端路由都回 index.html
app.get(/^(?!\/api\/).*/, (req, res, next) => {
  if (!existsSync(join(DIST, 'index.html'))) return next(); // 尚未 npm run build（開發時走 vite）
  // 這份 HTML 帶著店名，是會變的內容，不能讓瀏覽器留著舊的：
  // 店家改了店名，回頭客的分頁標題還是舊招牌。JS/CSS 檔名有雜湊，照樣可以長期快取。
  res.set('Cache-Control', 'no-store');
  res.type('html').send(renderIndex(req.path));
});

app.listen(PORT, '0.0.0.0', () => {
  const trial = trialInfo();
  console.log(`\n  ${getSettings().shop_name} 點餐系統已啟動`);
  console.log(`  店內網址   ${baseURL()}`);
  console.log(`  外帶訂餐   ${baseURL()}/takeout`);
  console.log(`  廚房看板   ${baseURL()}/kitchen`);
  console.log(`  後台管理   ${baseURL()}/admin   （店員密碼 ${STAFF_PIN}）`);
  if (trial) {
    console.log(
      trial.expired
        ? `  試用期     已於 ${trial.until} 結束，客人端停止接單`
        : `  試用期     到 ${trial.until} 為止，還剩 ${trial.daysLeft} 天`
    );
  }
  console.log('');
});
