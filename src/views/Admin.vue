<script setup lang="ts">
import { computed, onUnmounted, reactive, ref } from 'vue'
import StaffGate from '../components/StaffGate.vue'
import {
  api,
  clearPin,
  clockTime,
  downloadBackup,
  money,
  subscribe,
  type Bill,
  type Category,
  type MenuItem,
  type Order,
  type OrderItem,
  type QrTable,
  type Settings,
} from '../api'

/** 帳單一行：品名（選項）×數量 */
const describeLine = (i: OrderItem) =>
  `${i.name}${i.options.length ? `（${i.options.map((o) => o.name).join('／')}）` : ''}×${i.qty}`

type Tab = 'menu' | 'qrcode' | 'bills' | 'takeout' | 'report' | 'settings'
const tab = ref<Tab>('menu')
const TABS: { id: Tab; label: string }[] = [
  { id: 'menu', label: '菜單管理' },
  { id: 'qrcode', label: 'QRcode 列印' },
  { id: 'bills', label: '內用帳單' },
  { id: 'takeout', label: '外帶訂單' },
  { id: 'report', label: '今日報表' },
  { id: 'settings', label: '店家設定' },
]

const toast = ref('')
const say = (m: string) => {
  toast.value = m
  setTimeout(() => (toast.value = ''), 2600)
}
async function run(fn: () => Promise<unknown>, okMsg?: string) {
  try {
    await fn()
    if (okMsg) say(okMsg)
  } catch (e) {
    say(e instanceof Error ? e.message : '操作失敗')
  }
}

/* ---------- 菜單 ---------- */
const categories = ref<Category[]>([])
const newCat = ref('')
const draft = reactive<Record<number, { name: string; price: string; description: string }>>({})
const bulkText = ref('')
const bulkReplace = ref(false)

const loadMenu = async () => {
  categories.value = await api.menu()
  for (const c of categories.value) {
    if (!draft[c.id]) draft[c.id] = { name: '', price: '', description: '' }
  }
}

function addItem(cat: Category) {
  const d = draft[cat.id]
  if (!d?.name.trim() || d.price === '') return say('請填品名與價格')
  run(async () => {
    await api.addItem({
      categoryId: cat.id,
      name: d.name.trim(),
      price: Number(d.price),
      description: d.description.trim(),
    })
    d.name = ''
    d.price = ''
    d.description = ''
    await loadMenu()
  }, '已新增餐點')
}

const toggleSold = (item: MenuItem) =>
  run(async () => {
    await api.updateItem(item.id, { available: !item.available })
    await loadMenu()
  }, item.available ? `「${item.name}」已標示售完` : `「${item.name}」已重新上架`)

const editPrice = (item: MenuItem) => {
  const input = prompt(`修改「${item.name}」的價格`, String(item.price))
  if (input === null) return
  const price = Number(input)
  if (!Number.isFinite(price) || price < 0) return say('價格不正確')
  run(async () => {
    await api.updateItem(item.id, { price })
    await loadMenu()
  }, '價格已更新')
}

const removeItem = (item: MenuItem) => {
  if (!confirm(`確定刪除「${item.name}」？`)) return
  run(async () => {
    await api.deleteItem(item.id)
    await loadMenu()
  }, '已刪除')
}

const addCategory = () => {
  if (!newCat.value.trim()) return
  run(async () => {
    await api.addCategory(newCat.value.trim())
    newCat.value = ''
    await loadMenu()
  }, '已新增分類')
}

const removeCategory = (cat: Category) => {
  if (!confirm(`刪除分類「${cat.name}」會一併刪除其下 ${cat.items.length} 道菜，確定嗎？`)) return
  run(async () => {
    await api.deleteCategory(cat.id)
    await loadMenu()
  }, '已刪除分類')
}

const uploading = ref(0)
function uploadImage(item: MenuItem, event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  uploading.value = item.id
  run(async () => {
    const { url } = await api.upload(file)
    await api.updateItem(item.id, { image: url })
    await loadMenu()
  }, '照片已更新').finally(() => (uploading.value = 0))
}

const importBulk = () =>
  run(async () => {
    if (bulkReplace.value && !confirm('這會清空現有菜單再匯入，確定嗎？')) return
    const { count } = await api.bulkImport(bulkText.value, bulkReplace.value)
    bulkText.value = ''
    await loadMenu()
    say(`已匯入 ${count} 道菜`)
  })

/* ---------- QRcode ---------- */
const qr = ref<{ baseURL: string; tables: QrTable[]; takeout: { url: string; qr: string } } | null>(null)
const loadQr = async () => (qr.value = await api.qrcodes())

/* ---------- 帳單 ---------- */
const bills = ref<Bill[]>([])
const loadBills = async () => (bills.value = await api.bills())
const closeBill = (bill: Bill, payment: string) => {
  if (!confirm(`${bill.table.name} 結帳 ${money(bill.total)}，確定嗎？`)) return
  run(async () => {
    await api.closeBill(bill.id, payment)
    await Promise.all([loadBills(), loadReport()])
  }, '已完成結帳')
}
const printBill = (bill: Bill) => {
  printTarget.value = bill
  requestAnimationFrame(() => {
    window.print()
    printTarget.value = null
  })
}
const printTarget = ref<Bill | null>(null)
const printAll = () => window.print()

/* ---------- 外帶訂單 ---------- */
// 外帶不掛在桌次底下，每張單自己收款，所以跟內用帳單分開管
const takeoutOrders = ref<Order[]>([])
const loadTakeout = async () => (takeoutOrders.value = await api.takeoutOrders())

const TAKEOUT_STATUS: Record<string, string> = {
  awaiting: '待接單',
  pending: '待製作',
  preparing: '製作中',
  done: '已完成',
  cancelled: '已取消',
}

/** 店家開了「先確認再下廚」時，按這裡才把單子送進廚房 */
const acceptTakeout = (o: Order) =>
  run(async () => {
    await api.setOrderStatus(o.id, 'pending')
    await loadTakeout()
  }, `外帶 ${o.pickup_no} 已接單，已送進廚房`)

const rejectTakeout = (o: Order) => {
  if (!confirm(`確定要取消外帶 ${o.pickup_no}（${o.customer_name}）？建議先打電話告知客人。`)) return
  run(async () => {
    await api.setOrderStatus(o.id, 'cancelled')
    await loadTakeout()
  }, '已取消這張外帶單')
}

const payTakeout = (o: Order, payment: string) =>
  run(async () => {
    await api.payTakeout(o.id, payment)
    await Promise.all([loadTakeout(), loadReport()])
  }, `外帶 ${o.pickup_no} 已收款`)

/* ---------- 店家設定 ---------- */
const settings = ref<Settings | null>(null)
const settingsBusy = ref(false)
const loadSettings = async () => (settings.value = await api.settings())

async function saveSettings() {
  if (!settings.value) return
  if (!settings.value.shop_name.trim()) return say('店名不能空白')
  settingsBusy.value = true
  await run(async () => {
    settings.value = await api.saveSettings(settings.value!)
  }, '設定已儲存，客人端會立刻更新')
  settingsBusy.value = false
}

/* ---------- 報表 ---------- */
const report = ref<Awaited<ReturnType<typeof api.report>> | null>(null)
const loadReport = async () => (report.value = await api.report())

const backupBusy = ref(false)
async function saveBackup() {
  backupBusy.value = true
  await run(downloadBackup, '備份已下載，請妥善保存這個檔案')
  backupBusy.value = false
}

const menuItemCount = computed(() => categories.value.reduce((s, c) => s + c.items.length, 0))

function openTab(next: Tab) {
  tab.value = next
  if (next === 'qrcode' && !qr.value) run(loadQr)
  if (next === 'bills') run(loadBills)
  if (next === 'takeout') run(loadTakeout)
  if (next === 'report') run(loadReport)
  if (next === 'settings') run(loadSettings)
}

function logout() {
  clearPin()
  location.reload()
}

const ready = ref(false)
/** 登入成功後才載入，否則會在登入前就打 API 被擋 401 */
function start() {
  ready.value = true
  run(loadMenu)
}

const unsubscribe = subscribe({
  'order:new': () => refreshCurrentTab(),
  'order:update': () => refreshCurrentTab(),
})

/** 新單進來時只重抓當下這一頁，外帶單才會即時跳出來讓櫃檯看到 */
function refreshCurrentTab() {
  if (!ready.value) return
  if (tab.value === 'bills') loadBills()
  if (tab.value === 'takeout') loadTakeout()
}
onUnmounted(unsubscribe)
</script>

<template>
  <StaffGate @unlocked="start">
    <div class="admin">
      <header class="bar no-print">
        <h1>後台管理</h1>
        <nav>
          <button v-for="t in TABS" :key="t.id" :class="{ on: tab === t.id }" @click="openTab(t.id)">
            {{ t.label }}
          </button>
        </nav>
        <button @click="logout">登出</button>
      </header>

      <!-- 菜單管理 -->
      <main v-show="tab === 'menu'" class="wrap no-print">
        <div class="card pad row">
          <input v-model="newCat" placeholder="新增分類名稱（例：熱炒）" @keyup.enter="addCategory" />
          <button class="btn-primary" @click="addCategory">新增分類</button>
          <span class="muted">目前 {{ categories.length }} 個分類 · {{ menuItemCount }} 道菜</span>
        </div>

        <section v-for="cat in categories" :key="cat.id" class="card pad">
          <header class="cat-head">
            <h2>{{ cat.name }}</h2>
            <button class="btn-danger" @click="removeCategory(cat)">刪除分類</button>
          </header>

          <table class="items">
            <thead>
              <tr>
                <th>照片</th>
                <th>品名</th>
                <th>說明</th>
                <th class="num">價格</th>
                <th>狀態</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in cat.items" :key="item.id" :class="{ off: !item.available }">
                <td>
                  <label class="pic">
                    <img v-if="item.image" :src="item.image" :alt="item.name" />
                    <span v-else class="muted">{{ uploading === item.id ? '上傳中…' : '＋圖片' }}</span>
                    <input type="file" accept="image/*" hidden @change="uploadImage(item, $event)" />
                  </label>
                </td>
                <td>
                  {{ item.name }}
                  <div v-if="item.optionGroups.length" class="muted opt-tags">
                    {{ item.optionGroups.map((g) => g.name).join('、') }}
                  </div>
                </td>
                <td class="muted desc">{{ item.description || '—' }}</td>
                <td class="num tabular">{{ money(item.price) }}</td>
                <td>
                  <span class="pill" :class="item.available ? 'on' : 'off'">
                    {{ item.available ? '供應中' : '已售完' }}
                  </span>
                </td>
                <td class="acts">
                  <button @click="editPrice(item)">改價</button>
                  <button @click="toggleSold(item)">{{ item.available ? '標售完' : '重上架' }}</button>
                  <button class="btn-danger" @click="removeItem(item)">刪除</button>
                </td>
              </tr>
              <tr v-if="!cat.items.length">
                <td colspan="6" class="muted center">此分類尚無餐點</td>
              </tr>
            </tbody>
          </table>

          <div class="row add" v-if="draft[cat.id]">
            <input v-model="draft[cat.id].name" placeholder="品名" />
            <input v-model="draft[cat.id].price" type="number" min="0" placeholder="價格" class="w-price" />
            <input v-model="draft[cat.id].description" placeholder="說明（可空白）" />
            <button class="btn-primary" @click="addItem(cat)">新增</button>
          </div>
        </section>

        <section class="card pad">
          <h2>批次匯入菜單</h2>
          <p class="muted">
            每行一道菜，格式：<code>分類,品名,價格,說明</code>（說明可省略）。適合一次把整本菜單貼上來。
          </p>
          <textarea
            v-model="bulkText"
            rows="7"
            placeholder="熱炒,宮保雞丁,180,微辣&#10;熱炒,蒼蠅頭,160&#10;飲料,烏龍茶,30"
          ></textarea>
          <div class="row">
            <label class="check">
              <input type="checkbox" v-model="bulkReplace" />
              <span>覆蓋現有菜單（清空後重新匯入）</span>
            </label>
            <button class="btn-primary" :disabled="!bulkText.trim()" @click="importBulk">開始匯入</button>
          </div>
        </section>
      </main>

      <!-- QRcode -->
      <main v-show="tab === 'qrcode'" class="wrap">
        <div class="card pad row no-print">
          <div>
            <strong>掃碼網址</strong>
            <div class="muted">{{ qr?.baseURL }}/t/桌號 — 客人手機需連上店內 WiFi</div>
          </div>
          <button class="btn-primary" @click="printAll">列印全部 QRcode</button>
        </div>
        <div class="qr-grid">
          <!-- 外帶 QRcode 貼店門口或放名片、傳給熟客，掃了直接開外帶點餐頁 -->
          <figure v-if="qr?.takeout" class="card qr-card out">
            <img :src="qr.takeout.qr" alt="外帶訂餐 QRcode" />
            <figcaption>
              <strong>外帶訂餐</strong>
              <span class="muted small">貼店門口 / 傳給客人</span>
            </figcaption>
          </figure>
          <figure v-for="t in qr?.tables || []" :key="t.id" class="card qr-card">
            <img :src="t.qr" :alt="`${t.name} QRcode`" />
            <figcaption>
              <strong>{{ t.name }}</strong>
              <span class="muted small">掃描點餐</span>
            </figcaption>
          </figure>
        </div>
      </main>

      <!-- 帳單 -->
      <main v-show="tab === 'bills'" class="wrap no-print">
        <p v-if="!bills.length" class="card pad muted center">目前沒有未結帳的桌次</p>
        <section v-for="b in bills" :key="b.id" class="card pad bill">
          <header class="cat-head">
            <h2>{{ b.table.name }}</h2>
            <strong class="total tabular">{{ money(b.total) }}</strong>
          </header>
          <ul class="lines">
            <li v-for="o in b.orders" :key="o.id">
              <span class="muted">第 {{ o.id }} 單</span>
              <span>{{ o.items.map(describeLine).join('、') }}</span>
              <span class="tabular">{{ money(o.total) }}</span>
            </li>
          </ul>
          <div class="row">
            <button @click="printBill(b)">列印帳單</button>
            <button class="btn-ok" @click="closeBill(b, 'cash')">現金結帳</button>
            <button class="btn-ok" @click="closeBill(b, 'card')">刷卡結帳</button>
            <button class="btn-ok" @click="closeBill(b, 'mobile')">行動支付</button>
          </div>
        </section>
      </main>

      <!-- 外帶訂單 -->
      <main v-show="tab === 'takeout'" class="wrap no-print">
        <p v-if="!takeoutOrders.length" class="card pad muted center">今天還沒有外帶訂單</p>
        <section v-for="o in takeoutOrders" :key="o.id" class="card pad takeout" :class="o.status">
          <header class="cat-head">
            <h2>
              <span class="pickno tabular">{{ o.pickup_no }}</span>
              {{ o.customer_name }}
              <a :href="`tel:${o.customer_phone}`" class="phone">{{ o.customer_phone }}</a>
            </h2>
            <div class="badges">
              <span class="pill" :class="o.status === 'done' ? 'on' : 'off'">{{ TAKEOUT_STATUS[o.status] }}</span>
              <span class="pill" :class="o.paid_at ? 'on' : 'off'">
                {{ o.paid_at ? (o.payment === 'online' ? '已線上付款' : '已收款') : '未收款' }}
              </span>
              <strong class="total tabular">{{ money(o.total) }}</strong>
            </div>
          </header>

          <p class="muted when">
            取餐時間 {{ o.pickup_at || '盡快' }}　·　下單 {{ clockTime(o.created_at) }}
          </p>

          <ul class="lines">
            <li v-for="i in o.items" :key="i.id">
              <span class="muted">×{{ i.qty }}</span>
              <span>{{ describeLine(i) }}</span>
              <span class="tabular">{{ money(i.price * i.qty) }}</span>
            </li>
          </ul>

          <div class="row">
            <template v-if="o.status === 'awaiting'">
              <button class="btn-primary" @click="acceptTakeout(o)">接單，送進廚房</button>
              <button class="btn-danger" @click="rejectTakeout(o)">取消訂單</button>
            </template>
            <template v-if="!o.paid_at && o.status !== 'cancelled'">
              <button class="btn-ok" @click="payTakeout(o, 'cash')">現金收款</button>
              <button class="btn-ok" @click="payTakeout(o, 'card')">刷卡收款</button>
              <button class="btn-ok" @click="payTakeout(o, 'mobile')">行動支付</button>
            </template>
          </div>
        </section>
      </main>

      <!-- 報表 -->
      <main v-show="tab === 'report'" class="wrap no-print">
        <div class="stats">
          <div class="card pad stat">
            <span class="muted">今日營業額</span>
            <strong class="tabular">{{ money(report?.revenue || 0) }}</strong>
          </div>
          <div class="card pad stat">
            <span class="muted">內用（{{ report?.closedCount || 0 }} 桌）</span>
            <strong class="tabular">{{ money(report?.dineInRevenue || 0) }}</strong>
          </div>
          <div class="card pad stat">
            <span class="muted">外帶（{{ report?.takeoutCount || 0 }} 單）</span>
            <strong class="tabular">{{ money(report?.takeoutRevenue || 0) }}</strong>
          </div>
        </div>
        <section class="card pad backup">
          <div>
            <h2>資料備份</h2>
            <p class="muted">
              下載後請存到自己的電腦或雲端硬碟。建議每月做一次，萬一系統出狀況才有東西可以還原。
            </p>
          </div>
          <button class="btn-primary" :disabled="backupBusy" @click="saveBackup">
            {{ backupBusy ? '備份中…' : '下載備份' }}
          </button>
        </section>

        <section class="card pad">
          <h2>今日熱銷</h2>
          <table class="items">
            <thead>
              <tr><th>品名</th><th class="num">份數</th><th class="num">金額</th></tr>
            </thead>
            <tbody>
              <tr v-for="i in report?.topItems || []" :key="i.name">
                <td>{{ i.name }}</td>
                <td class="num tabular">{{ i.qty }}</td>
                <td class="num tabular">{{ money(i.amount) }}</td>
              </tr>
              <tr v-if="!report?.topItems?.length">
                <td colspan="3" class="muted center">今天還沒有銷售紀錄</td>
              </tr>
            </tbody>
          </table>
        </section>
      </main>

      <!-- 店家設定 -->
      <main v-show="tab === 'settings'" class="wrap no-print">
        <section v-if="settings" class="card pad settings">
          <h2>店家資料</h2>
          <p class="muted">
            這些會顯示在客人的點餐頁與訂單上。改完按儲存，客人端立刻更新，不需要重新部署。
          </p>
          <label class="field"><span>店名</span><input v-model="settings.shop_name" /></label>
          <label class="field"><span>電話</span><input v-model="settings.shop_phone" /></label>
          <label class="field"><span>地址</span><input v-model="settings.shop_address" /></label>

          <h2>外帶 / 遠端訂餐</h2>
          <label class="check">
            <input type="checkbox" true-value="1" false-value="0" v-model="settings.takeout_enabled" />
            <span>開放外帶線上訂餐（忙不過來時可以先關掉，客人就看不到下單按鈕）</span>
          </label>
          <label class="check">
            <input type="checkbox" true-value="1" false-value="0" v-model="settings.takeout_confirm_first" />
            <span>外帶單先由店員確認再進廚房（怕客人放鴿子時建議打開）</span>
          </label>
          <label class="field">
            <span>備餐時間（分鐘）</span>
            <input v-model="settings.takeout_lead_minutes" type="number" min="0" max="180" class="w-price" />
          </label>

          <h2>付款</h2>
          <label class="check">
            <input type="checkbox" true-value="1" false-value="0" v-model="settings.payment_online" />
            <span>外帶開放線上先付款</span>
          </label>
          <p v-if="settings.payment_online === '1' && settings.payment_provider === 'mock'" class="warn-box">
            目前是<strong>示範用的模擬付款</strong>：客人按下去就顯示已付款，但不會真的收到錢。
            要真的收款需要串接金流（綠界／藍新／LINE Pay）並填入商店代號。
          </p>

          <div class="row">
            <button class="btn-primary" :disabled="settingsBusy" @click="saveSettings">
              {{ settingsBusy ? '儲存中…' : '儲存設定' }}
            </button>
          </div>
        </section>
      </main>

      <!-- 列印用帳單 -->
      <div v-if="printTarget" class="print-only receipt">
        <h2>{{ printTarget.table.name }} 帳單</h2>
        <table>
          <tr v-for="o in printTarget.orders" :key="o.id">
            <td>{{ o.items.map(describeLine).join('、') }}</td>
            <td class="num">{{ money(o.total) }}</td>
          </tr>
          <tr class="grand">
            <td>合計</td>
            <td class="num">{{ money(printTarget.total) }}</td>
          </tr>
        </table>
      </div>

      <div v-if="toast" class="toast no-print">{{ toast }}</div>
    </div>
  </StaffGate>
</template>

<style scoped>
.admin {
  min-height: 100vh;
  padding-bottom: 40px;
}
.bar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  padding: 14px 20px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}
.bar nav {
  display: flex;
  gap: 8px;
  flex: 1;
  flex-wrap: wrap;
}
.bar nav button.on {
  background: var(--ink);
  border-color: var(--ink);
  color: #fff;
}
.wrap {
  max-width: 1080px;
  margin: 0 auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.pad {
  padding: 18px;
}
.row {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.row input {
  flex: 1;
  min-width: 140px;
}
.w-price {
  max-width: 120px;
  flex: none !important;
}
.add {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px dashed var(--line);
}
.cat-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.items {
  width: 100%;
  border-collapse: collapse;
}
.items th,
.items td {
  padding: 9px 8px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: middle;
}
.items th {
  font-size: 13px;
  color: var(--muted);
  font-weight: 600;
}
.num {
  text-align: right;
}
.center {
  text-align: center;
}
.desc {
  max-width: 260px;
}
tr.off td {
  opacity: 0.55;
}
.pic {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  border: 1px dashed var(--line);
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  overflow: hidden;
}
.pic img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.opt-tags {
  font-size: 12px;
  margin-top: 2px;
}
.pill {
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 13px;
  background: var(--ok-soft);
  color: var(--ok);
}
.pill.off {
  background: #f4eeee;
  color: #9b6a64;
}
.acts {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}
.acts button {
  padding: 6px 10px;
  font-size: 14px;
}
textarea {
  font-family: ui-monospace, 'Cascadia Code', monospace;
  margin: 10px 0;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
}
.check input {
  width: auto;
}
code {
  background: #f1ece4;
  padding: 1px 6px;
  border-radius: 5px;
}
.qr-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
}
.qr-card {
  margin: 0;
  padding: 14px;
  text-align: center;
  break-inside: avoid;
}
.qr-card img {
  width: 100%;
  aspect-ratio: 1;
}
.qr-card figcaption {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 8px;
}
.qr-card strong {
  font-size: 20px;
}
.small {
  font-size: 13px;
}
.bill .total {
  font-size: 22px;
  color: var(--brand);
}
.lines {
  list-style: none;
  margin: 0 0 14px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.lines li {
  display: grid;
  grid-template-columns: 80px 1fr auto;
  gap: 12px;
}
/* 外帶訂單 */
.takeout .total {
  font-size: 22px;
  color: var(--brand);
}
/* 還沒接的單要跳出來，櫃檯不能漏看 */
.takeout.awaiting {
  border-left: 6px solid var(--warn);
}
.takeout.cancelled {
  opacity: 0.6;
}
.pickno {
  display: inline-block;
  min-width: 58px;
  margin-right: 8px;
  padding: 2px 10px;
  border-radius: 8px;
  background: var(--brand);
  color: #fff;
  text-align: center;
}
.phone {
  margin-left: 10px;
  font-size: 15px;
  font-weight: 500;
  color: var(--brand-dark);
}
.badges {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.when {
  margin: 0 0 10px;
  font-size: 14px;
}

/* 店家設定 */
.settings {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 620px;
}
.settings h2 {
  margin-top: 10px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
  font-size: 17px;
}
.settings h2:first-child {
  margin-top: 0;
  padding-top: 0;
  border-top: none;
}
.settings p {
  margin: 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field > span {
  font-weight: 600;
}
.warn-box {
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: 14px;
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat strong {
  font-size: 30px;
}
.backup {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.backup p {
  margin: 4px 0 0;
  max-width: 48ch;
}
.print-only {
  display: none;
}
@media print {
  .print-only {
    display: block;
  }
  .receipt {
    padding: 20px;
  }
  .receipt table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 12px;
  }
  .receipt td {
    padding: 6px 0;
    border-bottom: 1px solid #ddd;
  }
  .receipt .grand td {
    font-weight: 700;
    font-size: 18px;
    border-bottom: none;
  }
}
</style>
