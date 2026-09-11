// 菜單種子匯入。
// 手動重灌：npm run seed:menu
// 雲端第一次啟動時，index.js 也會自動呼叫 seedMenu()，否則店家打開會是空菜單。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { db, saveSettings } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function seedMenu() {
  const seed = JSON.parse(readFileSync(join(__dirname, 'menu.seed.json'), 'utf8'));

  // 種子檔裡的店名/電話/地址一起帶進設定，店家之後可在後台「店家設定」自行修改
  saveSettings({
    shop_name: seed['店名'],
    shop_phone: seed['電話'],
    shop_address: seed['地址'],
  });

  db.exec('DELETE FROM item_option_groups');
  db.exec('DELETE FROM option_choices');
  db.exec('DELETE FROM option_groups');
  db.exec('DELETE FROM menu_items');
  db.exec('DELETE FROM categories');

  /* 選項群組 */
  const insGroup = db.prepare('INSERT INTO option_groups (key, name, mode, required, sort) VALUES (?, ?, ?, ?, ?)');
  const insChoice = db.prepare('INSERT INTO option_choices (group_id, name, price_delta, sort) VALUES (?, ?, ?, ?)');
  const groupIdByKey = new Map();

  (seed.optionGroups || []).forEach((g, gi) => {
    const id = insGroup.run(g.key, g.name, g.mode || 'single', g.required ? 1 : 0, gi).lastInsertRowid;
    groupIdByKey.set(g.key, id);
    (g.choices || []).forEach((c, ci) => insChoice.run(id, c.name, Math.round(c.price_delta || 0), ci));
  });

  /* 分類與品項 */
  const insCat = db.prepare('INSERT INTO categories (name, sort) VALUES (?, ?)');
  const insItem = db.prepare(
    'INSERT INTO menu_items (category_id, name, description, price, image, available, sort) VALUES (?, ?, ?, ?, ?, 1, ?)'
  );
  const linkGroup = db.prepare('INSERT INTO item_option_groups (item_id, group_id, sort) VALUES (?, ?, ?)');

  let itemCount = 0;
  seed.categories.forEach((cat, ci) => {
    const catId = insCat.run(cat.name, ci).lastInsertRowid;
    (cat.items || []).forEach((it, ii) => {
      const itemId = insItem
        .run(catId, it.name, it.description || '', Math.round(it.price), it.image || '', ii)
        .lastInsertRowid;
      (it.options || []).forEach((key, oi) => {
        const groupId = groupIdByKey.get(key);
        if (!groupId) throw new Error(`「${it.name}」引用了不存在的選項群組：${key}`);
        linkGroup.run(itemId, groupId, oi);
      });
      itemCount++;
    });
  });

  return { categories: seed.categories.length, items: itemCount, groups: groupIdByKey.size };
}

// 直接執行這個檔案時才跑（被 import 時不動作）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = seedMenu();
  console.log(`✓ 匯入完成：${r.categories} 個分類、${r.items} 道菜、${r.groups} 個選項群組`);
}
