// 用法: npm run qrcodes  → 產生 qrcodes.html，雙擊開啟即可列印
import QRCode from 'qrcode';
import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getSettings } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3001);

const VIRTUAL_ADAPTER = /vEthernet|WSL|Hyper-?V|VirtualBox|VMware|Docker|Loopback|Bluetooth|藍牙/i;
function lanIP() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_ADAPTER.test(name)) continue;
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (net.address.startsWith('169.254.')) continue;
      found.push(net.address);
    }
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return found.sort((a, b) => rank(a) - rank(b))[0] || 'localhost';
}

const base = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://${lanIP()}:${PORT}`;
// 部署在雲端（https）時，客人用手機網路就能點；區網版才需要連店內 WiFi
const isCloud = base.startsWith('https://');
const shopName = getSettings().shop_name;
const tables = db.prepare('SELECT * FROM tables ORDER BY id').all();

const cards = await Promise.all(
  tables.map(async (t) => {
    const url = `${base}/t/${t.id}`;
    const qr = await QRCode.toDataURL(url, { width: 600, margin: 1, errorCorrectionLevel: 'M' });
    return `    <figure class="card">
      <div class="no">${t.id}</div>
      <img src="${qr}" alt="${t.name} QRcode" />
      <figcaption>
        <strong>掃描點餐</strong>
        <span>${url}</span>
      </figcaption>
    </figure>`;
  })
);

// 外帶 QRcode：貼店門口、放櫃檯或印在名片上，客人掃了直接開線上訂餐頁
const takeoutUrl = `${base}/takeout`;
const takeoutCard = `    <figure class="card">
      <div class="no out">外帶</div>
      <img src="${await QRCode.toDataURL(takeoutUrl, {
        width: 600,
        margin: 1,
        errorCorrectionLevel: 'M',
      })}" alt="外帶訂餐 QRcode" />
      <figcaption>
        <strong>線上訂餐・外帶自取</strong>
        <span>${takeoutUrl}</span>
      </figcaption>
    </figure>`;

const html = `<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="UTF-8" />
<title>${shopName} — 桌號 QRcode</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px; background: #faf7f2; color: #1f1b16;
    font-family: 'Noto Sans TC', 'Microsoft JhengHei', system-ui, sans-serif;
  }
  header { text-align: center; margin-bottom: 18px; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  header p { margin: 0; color: #797064; font-size: 14px; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
  .card {
    margin: 0; padding: 16px; background: #fff; border: 2px solid #1f1b16;
    border-radius: 12px; text-align: center; break-inside: avoid; page-break-inside: avoid;
  }
  .no { font-size: 40px; font-weight: 800; line-height: 1; margin-bottom: 6px; }
  .no::after { content: ' 號桌'; font-size: 18px; font-weight: 600; }
  .no.out::after { content: ''; }
  .card img { width: 100%; max-width: 260px; aspect-ratio: 1; }
  figcaption { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
  figcaption strong { font-size: 16px; }
  figcaption span { font-size: 10px; color: #797064; word-break: break-all; }
  .tip { margin-top: 20px; text-align: center; color: #797064; font-size: 13px; }
  @media print {
    body { background: #fff; padding: 0; }
    header, .tip { display: none; }
    .grid { gap: 10px; }
  }
</style>
</head>
<body>
  <header>
    <h1>${shopName} — 桌號 QRcode</h1>
    <p>按 Ctrl+P 列印，剪下後貼在各桌上。網址：${base}</p>
  </header>
  <div class="grid">
${[takeoutCard, ...cards].join('\n')}
  </div>
  <p class="tip">${
    isCloud
      ? '※ 客人用自己的手機網路就能掃，不必連店內 WiFi。網址固定不會變，這批 QRcode 可以一直用。'
      : '※ 客人手機需連上店內 WiFi 才掃得開。若路由器換了 IP，請重新執行 npm run qrcodes 並重印。'
  }</p>
</body>
</html>
`;

const out = join(__dirname, '..', 'qrcodes.html');
writeFileSync(out, html, 'utf8');
console.log(`✓ 已產生 ${out}`);
console.log(`  網址base：${base}（共 ${tables.length} 桌）`);
console.log('  雙擊該檔案開啟，按 Ctrl+P 列印');
