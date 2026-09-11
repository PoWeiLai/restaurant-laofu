<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  api,
  money,
  subscribe,
  type CartPayload,
  type Category,
  type MenuItem,
  type Order,
  type OptionChoice,
  refreshShop,
  useShopTitle,
} from '../api'
import { rememberTakeout } from '../takeout'

/**
 * 客人點餐頁。內用與外帶共用同一份菜單、選項與購物車，只有「這張單要送去哪裡」不同：
 * 內用綁桌號、吃完一起結帳；外帶留姓名電話、給取餐號、到店付款。
 */
const props = defineProps<{ mode?: 'dine_in' | 'takeout'; tableId?: string }>()
const isTakeout = computed(() => props.mode === 'takeout')
const tableNo = computed(() => Number(props.tableId))
const router = useRouter()

const shop = useShopTitle(props.mode === 'takeout' ? '外帶線上訂餐' : '線上點餐')
const categories = ref<Category[]>([])
const activeCat = ref<number | null>(null)
const myOrders = ref<Order[]>([])
const loading = ref(true)
const error = ref('')
const toast = ref('')
const view = ref<'menu' | 'orders'>('menu')
const cartOpen = ref(false)
const checkoutOpen = ref(false)
const submitting = ref(false)

/** 試用期已過或店家關掉外帶時，菜單照看但不能送單 */
const closedReason = computed(() => {
  if (shop.value?.trial?.expired) return '系統試用期已結束，目前暫停接單'
  if (isTakeout.value && shop.value && !shop.value.takeoutEnabled) return '本店目前暫停外帶接單，敬請見諒'
  return ''
})

interface CartLine {
  key: string
  item: MenuItem
  choices: OptionChoice[]
  qty: number
  note: string
}
const cart = reactive<CartLine[]>([])

const unitPrice = (item: MenuItem, choices: OptionChoice[]) =>
  item.price + choices.reduce((s, c) => s + c.price_delta, 0)
const cartCount = computed(() => cart.reduce((s, l) => s + l.qty, 0))
const cartTotal = computed(() => cart.reduce((s, l) => s + unitPrice(l.item, l.choices) * l.qty, 0))
const orderedTotal = computed(() => myOrders.value.reduce((s, o) => s + o.total, 0))

const STATUS_TEXT: Record<string, string> = {
  awaiting: '已送出，等待店家接單',
  pending: '已送出，等待廚房確認',
  preparing: '廚房製作中',
  done: '已完成出餐',
  cancelled: '已取消',
}

function say(msg: string) {
  toast.value = msg
  setTimeout(() => (toast.value = ''), 2600)
}

/* ---------- 選項挑選 ---------- */
const picking = ref<MenuItem | null>(null)
/** groupId -> 已選的 choiceId 陣列 */
const picked = reactive<Record<number, number[]>>({})
const pickNote = ref('')

function openPicker(item: MenuItem) {
  picking.value = item
  pickNote.value = ''
  for (const key of Object.keys(picked)) delete picked[Number(key)]
  for (const g of item.optionGroups) {
    // 非必選的群組預設帶第一個「不加價」選項，客人不用每次都點
    picked[g.id] = g.required ? [] : g.choices[0] ? [g.choices[0].id] : []
  }
}

function toggleChoice(groupId: number, choice: OptionChoice, mode: 'single' | 'multi') {
  const current = picked[groupId] || []
  if (mode === 'single') {
    picked[groupId] = current.includes(choice.id) ? [] : [choice.id]
  } else {
    picked[groupId] = current.includes(choice.id)
      ? current.filter((id) => id !== choice.id)
      : [...current, choice.id]
  }
}

const pickedChoices = computed<OptionChoice[]>(() => {
  if (!picking.value) return []
  return picking.value.optionGroups.flatMap((g) =>
    g.choices.filter((c) => (picked[g.id] || []).includes(c.id))
  )
})

const missingGroup = computed(() =>
  picking.value?.optionGroups.find((g) => g.required && (picked[g.id] || []).length === 0)
)

const pickerPrice = computed(() =>
  picking.value ? unitPrice(picking.value, pickedChoices.value) : 0
)

function confirmPick() {
  const item = picking.value
  if (!item) return
  if (missingGroup.value) return say(`請選擇「${missingGroup.value.name}」`)
  addToCart(item, pickedChoices.value, pickNote.value)
  picking.value = null
}

/* ---------- 購物車 ---------- */
function addToCart(item: MenuItem, choices: OptionChoice[], note: string) {
  // 同一道菜、相同選項與備註才併行；否則各自成一列
  const key = `${item.id}|${choices.map((c) => c.id).sort((a, b) => a - b).join(',')}|${note}`
  const found = cart.find((l) => l.key === key)
  if (found) found.qty++
  else cart.push({ key, item, choices, qty: 1, note })
  say(`已加入「${item.name}」`)
}

function quickAdd(item: MenuItem) {
  if (!item.available) return
  if (item.optionGroups.length) openPicker(item)
  else addToCart(item, [], '')
}

function setQty(line: CartLine, qty: number) {
  if (qty <= 0) cart.splice(cart.indexOf(line), 1)
  else line.qty = Math.min(99, qty)
}

/** 這道菜在購物車裡的總數量，顯示在菜單上 */
const countInCart = (itemId: number) =>
  cart.filter((l) => l.item.id === itemId).reduce((s, l) => s + l.qty, 0)

const cartPayload = (): CartPayload[] =>
  cart.map((l) => ({
    itemId: l.item.id,
    qty: l.qty,
    note: l.note,
    choiceIds: l.choices.map((c) => c.id),
  }))

/* ---------- 外帶：取餐人與取餐時間 ---------- */
const customer = reactive({ name: '', phone: '' })
const pickupAt = ref('') // 空字串 = 盡快
const payWay = ref<'counter' | 'online'>('counter')

/** 可選的取餐時段：從「現在＋備餐時間」開始，每 10 分鐘一格，排到兩小時後 */
const pickupSlots = computed(() => {
  const lead = shop.value?.takeoutLeadMinutes ?? 20
  const start = new Date(Date.now() + lead * 60000)
  start.setMinutes(Math.ceil(start.getMinutes() / 10) * 10, 0, 0)
  return Array.from({ length: 12 }, (_, i) => {
    const t = new Date(start.getTime() + i * 10 * 60000)
    return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  })
})

const phoneLooksValid = computed(() => /^[0-9+\-() ]{8,20}$/.test(customer.phone.trim()))
const canSubmitTakeout = computed(() => customer.name.trim() !== '' && phoneLooksValid.value)

async function loadMenu() {
  categories.value = await api.menu()
  if (activeCat.value === null) activeCat.value = categories.value[0]?.id ?? null
}

async function loadOrders() {
  if (isTakeout.value) return // 外帶單送出後直接跳到進度頁，這裡不需要清單
  const data = await api.tableSession(tableNo.value)
  myOrders.value = data.orders
}

/** 內用：直接送進廚房，吃完再一起結帳 */
async function submitDineIn() {
  await api.placeOrder(tableNo.value, cartPayload())
  cart.splice(0, cart.length)
  cartOpen.value = false
  await loadOrders()
  view.value = 'orders'
  say('訂單已送出，廚房已收到 🍜')
}

/** 外帶：留下取餐人資料，拿到取餐號，線上付款或到店付款 */
async function submitTakeout() {
  const order = await api.placeTakeout(
    { name: customer.name.trim(), phone: customer.phone.trim() },
    cartPayload(),
    pickupAt.value
  )
  rememberTakeout(order.track_code)
  cart.splice(0, cart.length)
  checkoutOpen.value = false
  cartOpen.value = false

  // 訂單已經成立，線上付款失敗不該把單子弄丟——付款收不到就照常到店付
  if (payWay.value === 'online' && shop.value?.paymentOnline) {
    try {
      await api.payTakeoutOnline(order.track_code)
    } catch (e) {
      say(e instanceof Error ? e.message : '線上付款未完成，請到店付款')
    }
  }
  router.push(`/takeout/${order.track_code}`)
}

async function submit() {
  if (cart.length === 0) return
  if (closedReason.value) return say(closedReason.value)
  // 外帶要先填取餐人資料，第一次按送出先打開結帳表單
  if (isTakeout.value && !checkoutOpen.value) {
    cartOpen.value = false
    checkoutOpen.value = true
    return
  }
  if (isTakeout.value && !canSubmitTakeout.value) {
    return say(customer.name.trim() ? '請填寫正確的連絡電話' : '請填寫取餐人姓名')
  }

  submitting.value = true
  try {
    await (isTakeout.value ? submitTakeout() : submitDineIn())
  } catch (e) {
    say(e instanceof Error ? e.message : '送出失敗，請再試一次')
  } finally {
    submitting.value = false
  }
}

watch(
  [tableNo, isTakeout],
  async () => {
    loading.value = true
    error.value = ''
    try {
      await Promise.all([refreshShop(), loadMenu(), loadOrders()])
    } catch (e) {
      error.value = e instanceof Error ? e.message : '載入失敗'
    } finally {
      loading.value = false
    }
  },
  { immediate: true }
)

const unsubscribe = subscribe({
  'order:update': (o: Order) => {
    if (!isTakeout.value && o.table_id === tableNo.value) loadOrders()
  },
  'bill:closed': (b: { tableId: number }) => {
    if (!isTakeout.value && b.tableId === tableNo.value) {
      myOrders.value = []
      say('本桌已結帳，感謝光臨！')
    }
  },
  'menu:update': () => loadMenu(),
  'shop:update': () => refreshShop(),
})
onUnmounted(unsubscribe)
</script>

<template>
  <div class="page">
    <header class="top">
      <div>
        <div class="shop small">{{ shop?.name || '線上點餐' }}</div>
        <h1 v-if="isTakeout">外帶自取</h1>
        <h1 v-else>{{ tableNo }} 號桌</h1>
      </div>
      <div class="switch">
        <button :class="{ on: view === 'menu' }" @click="view = 'menu'">菜單</button>
        <button v-if="!isTakeout" :class="{ on: view === 'orders' }" @click="view = 'orders'">
          已點餐點<span v-if="myOrders.length" class="dot">{{ myOrders.length }}</span>
        </button>
        <RouterLink v-else to="/takeout/mine" class="mine">我的訂單</RouterLink>
      </div>
    </header>

    <p v-if="closedReason" class="notice">{{ closedReason }}</p>
    <p v-else-if="isTakeout && shop" class="notice soft">
      線上點好、時間到再來拿，不用現場排隊。備餐約 {{ shop.takeoutLeadMinutes }} 分鐘，到店取餐時付款。
    </p>

    <p v-if="loading" class="state muted">菜單載入中…</p>
    <p v-else-if="error" class="state error">{{ error }}</p>

    <!-- 菜單 -->
    <template v-else-if="view === 'menu'">
      <nav class="cats">
        <button v-for="c in categories" :key="c.id" :class="{ on: activeCat === c.id }" @click="activeCat = c.id">
          {{ c.name }}
        </button>
      </nav>

      <main class="list">
        <template v-for="c in categories" :key="c.id">
          <section v-if="activeCat === c.id">
            <article v-for="item in c.items" :key="item.id" class="card item" :class="{ soldout: !item.available }">
              <img v-if="item.image" :src="item.image" :alt="item.name" class="thumb" />
              <div v-else class="thumb placeholder" aria-hidden="true">{{ item.name.slice(0, 2) }}</div>
              <div class="info">
                <h3>{{ item.name }}</h3>
                <p v-if="item.description" class="muted small">{{ item.description }}</p>
                <p v-if="item.optionGroups.length" class="muted small opts">
                  可選：{{ item.optionGroups.map((g) => g.name).join('、') }}
                </p>
                <div class="price tabular">{{ money(item.price) }}<span v-if="item.optionGroups.length" class="muted"> 起</span></div>
              </div>
              <div class="action">
                <span v-if="!item.available" class="tag">售完</span>
                <template v-else>
                  <span v-if="countInCart(item.id)" class="incart tabular">{{ countInCart(item.id) }}</span>
                  <button class="btn-primary" @click="quickAdd(item)">
                    {{ item.optionGroups.length ? '選擇' : '加入' }}
                  </button>
                </template>
              </div>
            </article>
            <p v-if="c.items.length === 0" class="state muted">此分類尚未有餐點</p>
          </section>
        </template>
      </main>
    </template>

    <!-- 已點餐點（內用） -->
    <main v-else class="list">
      <p v-if="myOrders.length === 0" class="state muted">本桌還沒有訂單，先去菜單點餐吧</p>
      <article v-for="o in myOrders" :key="o.id" class="card order">
        <header>
          <strong>第 {{ o.id }} 單</strong>
          <span class="status" :data-status="o.status">{{ STATUS_TEXT[o.status] }}</span>
        </header>
        <ul>
          <li v-for="i in o.items" :key="i.id">
            <span>
              {{ i.name }}
              <em v-if="i.options.length" class="muted opt-line">{{ i.options.map((o2) => o2.name).join('／') }}</em>
              <em v-if="i.note" class="muted opt-line">備註：{{ i.note }}</em>
            </span>
            <span class="tabular muted">×{{ i.qty }}</span>
            <span class="tabular">{{ money(i.price * i.qty) }}</span>
          </li>
        </ul>
        <footer class="tabular">小計 {{ money(o.total) }}</footer>
      </article>
      <div v-if="myOrders.length" class="card sum">
        <span>本桌合計</span><strong class="tabular">{{ money(orderedTotal) }}</strong>
      </div>
    </main>

    <!-- 選項挑選 -->
    <div v-if="picking" class="scrim" @click="picking = null"></div>
    <section v-if="picking" class="sheet">
      <header>
        <div>
          <h2>{{ picking.name }}</h2>
          <span class="muted small">{{ money(picking.price) }} 起</span>
        </div>
        <button @click="picking = null">關閉</button>
      </header>
      <div class="sheet-body">
        <fieldset v-for="g in picking.optionGroups" :key="g.id" class="group">
          <legend>
            {{ g.name }}
            <span class="req" :class="{ must: g.required }">{{ g.required ? '必選' : '選填' }}</span>
          </legend>
          <div class="choices">
            <button
              v-for="c in g.choices"
              :key="c.id"
              class="choice"
              :class="{ on: (picked[g.id] || []).includes(c.id) }"
              @click="toggleChoice(g.id, c, g.mode)"
            >
              {{ c.name }}
              <span v-if="c.price_delta" class="delta tabular">+{{ c.price_delta }}</span>
            </button>
          </div>
        </fieldset>
        <label class="note-field">
          <span class="muted small">備註（例：不要辣、麵少一點）</span>
          <input v-model="pickNote" placeholder="可不填" />
        </label>
      </div>
      <footer class="sheet-foot">
        <div class="tabular">單價 <strong>{{ money(pickerPrice) }}</strong></div>
        <button class="btn-primary big" @click="confirmPick">加入購物車</button>
      </footer>
    </section>

    <!-- 購物車 -->
    <div v-if="cartOpen" class="scrim" @click="cartOpen = false"></div>
    <section v-if="cartOpen" class="sheet">
      <header>
        <h2>購物車</h2>
        <button @click="cartOpen = false">關閉</button>
      </header>
      <div class="sheet-body">
        <div v-for="l in cart" :key="l.key" class="line">
          <div class="line-top">
            <div>
              <strong>{{ l.item.name }}</strong>
              <div v-if="l.choices.length" class="muted small">{{ l.choices.map((c) => c.name).join('／') }}</div>
              <div v-if="l.note" class="muted small">備註：{{ l.note }}</div>
            </div>
            <span class="tabular">{{ money(unitPrice(l.item, l.choices) * l.qty) }}</span>
          </div>
          <div class="stepper">
            <button @click="setQty(l, l.qty - 1)">−</button>
            <span class="tabular">{{ l.qty }}</span>
            <button @click="setQty(l, l.qty + 1)">＋</button>
          </div>
        </div>
      </div>
      <footer class="sheet-foot">
        <div class="tabular">合計 <strong>{{ money(cartTotal) }}</strong></div>
        <button class="btn-primary big" :disabled="submitting || !!closedReason" @click="submit">
          {{ isTakeout ? '下一步：填取餐資料' : submitting ? '送出中…' : '送出訂單' }}
        </button>
      </footer>
    </section>

    <!-- 外帶：取餐人資料 -->
    <div v-if="checkoutOpen" class="scrim" @click="checkoutOpen = false"></div>
    <section v-if="checkoutOpen" class="sheet">
      <header>
        <h2>取餐資料</h2>
        <button @click="checkoutOpen = false">返回</button>
      </header>
      <div class="sheet-body">
        <label class="field">
          <span>取餐人姓名<b>＊</b></span>
          <input v-model="customer.name" placeholder="例：王小明" autocomplete="name" />
        </label>
        <label class="field">
          <span>連絡電話<b>＊</b></span>
          <!-- 電話用 tel 鍵盤；姓名不設，否則手機打不出中文 -->
          <input v-model="customer.phone" type="tel" inputmode="tel" placeholder="例：0912345678" autocomplete="tel" />
          <em v-if="customer.phone && !phoneLooksValid" class="warn-text">電話號碼格式看起來不對</em>
        </label>
        <div class="field">
          <span>取餐時間</span>
          <div class="choices">
            <button class="choice" :class="{ on: pickupAt === '' }" @click="pickupAt = ''">盡快</button>
            <button
              v-for="t in pickupSlots"
              :key="t"
              class="choice tabular"
              :class="{ on: pickupAt === t }"
              @click="pickupAt = t"
            >
              {{ t }}
            </button>
          </div>
        </div>
        <div v-if="shop?.paymentOnline" class="field">
          <span>付款方式</span>
          <div class="choices">
            <button class="choice" :class="{ on: payWay === 'counter' }" @click="payWay = 'counter'">
              到店付款
            </button>
            <button class="choice" :class="{ on: payWay === 'online' }" @click="payWay = 'online'">
              線上先付
            </button>
          </div>
          <em v-if="payWay === 'online' && shop.paymentProvider === 'mock'" class="warn-text">
            目前是示範用的模擬付款，不會真的扣款
          </em>
        </div>

        <div class="recap">
          <div v-for="l in cart" :key="l.key" class="recap-line">
            <span>{{ l.item.name }} ×{{ l.qty }}</span>
            <span class="tabular">{{ money(unitPrice(l.item, l.choices) * l.qty) }}</span>
          </div>
        </div>
        <p class="muted small">送出後會給你一組取餐號，到店報號碼就能取餐。</p>
      </div>
      <footer class="sheet-foot">
        <div class="tabular">合計 <strong>{{ money(cartTotal) }}</strong></div>
        <button class="btn-primary big" :disabled="submitting || !canSubmitTakeout" @click="submit">
          {{ submitting ? '送出中…' : '送出訂單' }}
        </button>
      </footer>
    </section>

    <button
      v-if="cartCount && !cartOpen && !picking && !checkoutOpen"
      class="cartbar btn-primary"
      @click="cartOpen = true"
    >
      <span class="badge tabular">{{ cartCount }}</span>
      <span>查看購物車</span>
      <span class="tabular">{{ money(cartTotal) }}</span>
    </button>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<style scoped>
.page {
  max-width: 640px;
  margin: 0 auto;
  padding-bottom: 96px;
  min-height: 100%;
}
/* 店內招牌感：紅底金邊 */
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px;
  background: linear-gradient(180deg, #a81c16, #8a140f);
  border-bottom: 3px solid var(--gold);
  color: #fff;
  position: sticky;
  top: 0;
  z-index: 20;
}
.top h1 {
  color: #fff;
}
.shop {
  color: var(--gold-soft);
  font-weight: 700;
  letter-spacing: 3px;
}
.small {
  font-size: 13px;
}
.switch {
  display: flex;
  gap: 6px;
  align-items: center;
}
.switch button {
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(255, 255, 255, 0.4);
  color: #fff;
}
.switch button.on {
  background: var(--gold-soft);
  border-color: var(--gold);
  color: var(--brand-dark);
  font-weight: 600;
}
.mine {
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  text-decoration: none;
  font-size: 15px;
}
.dot {
  display: inline-block;
  min-width: 20px;
  margin-left: 6px;
  padding: 0 5px;
  background: var(--gold);
  color: var(--brand-dark);
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
}
.switch button.on .dot {
  background: var(--brand);
  color: #fff;
}
.notice {
  margin: 0;
  padding: 12px 16px;
  background: var(--warn-soft);
  color: var(--warn);
  text-align: center;
  font-weight: 600;
}
.notice.soft {
  background: var(--gold-soft);
  color: var(--brand-dark);
  font-weight: 500;
  font-size: 14px;
}
.cats {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 12px 16px;
  position: sticky;
  top: 75px;
  background: rgba(244, 227, 217, 0.94);
  backdrop-filter: blur(6px);
  z-index: 10;
  scrollbar-width: none;
}
.cats::-webkit-scrollbar {
  display: none;
}
.cats button {
  white-space: nowrap;
}
.cats button.on {
  background: var(--ink);
  border-color: var(--ink);
  color: #fff;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 16px 16px;
}
.list section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.item {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 12px;
}
.item.soldout {
  opacity: 0.55;
}
.thumb {
  width: 76px;
  height: 76px;
  border-radius: 10px;
  object-fit: cover;
  flex: none;
}
/* 還沒拍照的品項：用品名前兩字做字卡，不留空白 */
.placeholder {
  display: grid;
  place-items: center;
  background: linear-gradient(140deg, var(--brand-soft), #f6e3d8);
  color: var(--brand-dark);
  font-weight: 700;
  font-size: 22px;
  letter-spacing: 1px;
}
.info {
  flex: 1;
  min-width: 0;
}
.opts {
  margin: 2px 0 0;
}
.price {
  margin-top: 4px;
  font-weight: 700;
  color: var(--brand);
}
.action {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}
.incart {
  min-width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: var(--brand-soft);
  color: var(--brand-dark);
  font-weight: 700;
  font-size: 14px;
}
.tag {
  padding: 6px 10px;
  border-radius: 999px;
  background: #f1ece4;
  color: var(--muted);
  font-size: 13px;
}
.stepper {
  display: flex;
  align-items: center;
  gap: 4px;
}
.stepper button {
  width: 36px;
  height: 36px;
  padding: 0;
  font-size: 18px;
  line-height: 1;
}
.stepper span {
  min-width: 28px;
  text-align: center;
  font-weight: 600;
}
.state {
  padding: 40px 16px;
  text-align: center;
}
.error {
  color: #b3261e;
}
.order {
  padding: 14px;
}
.order header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.status {
  font-size: 13px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warn);
}
.status[data-status='done'] {
  background: var(--ok-soft);
  color: var(--ok);
}
.order ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.order li {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 12px;
  align-items: start;
}
.opt-line {
  display: block;
  font-style: normal;
  font-size: 13px;
}
.order footer {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--line);
  text-align: right;
  font-weight: 600;
}
.sum {
  display: flex;
  justify-content: space-between;
  padding: 14px;
  font-size: 18px;
}
.cartbar {
  position: fixed;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  width: min(608px, calc(100vw - 32px));
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  font-size: 17px;
  z-index: 30;
  box-shadow: var(--shadow);
}
.cartbar span:nth-child(2) {
  flex: 1;
  text-align: left;
}
.badge {
  background: #fff;
  color: var(--brand);
  border-radius: 999px;
  min-width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 14px;
}
.scrim {
  position: fixed;
  inset: 0;
  background: rgba(31, 27, 22, 0.4);
  z-index: 40;
}
.sheet {
  position: fixed;
  left: 50%;
  bottom: 0;
  transform: translateX(-50%);
  width: min(640px, 100vw);
  max-height: 86vh;
  background: var(--surface);
  border-radius: 18px 18px 0 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
}
.sheet > header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 16px;
  border-bottom: 1px solid var(--line);
}
.sheet-body {
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.group {
  border: none;
  padding: 0;
  margin: 0;
}
.group legend {
  padding: 0 0 8px;
  font-weight: 600;
}
.req {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 999px;
  background: #f1ece4;
  color: var(--muted);
}
.req.must {
  background: var(--brand-soft);
  color: var(--brand-dark);
}
.choices {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.choice {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}
.choice.on {
  background: var(--brand-soft);
  border-color: var(--brand);
  color: var(--brand-dark);
  font-weight: 600;
}
.delta {
  font-size: 13px;
  color: var(--brand);
}
.note-field,
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field > span {
  font-weight: 600;
}
.field b {
  color: var(--brand);
  margin-left: 2px;
}
.warn-text {
  font-style: normal;
  font-size: 13px;
  color: #b3261e;
}
.recap {
  border-top: 1px dashed var(--line);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.recap-line {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--muted);
  font-size: 14px;
}
.line-top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.sheet-foot {
  padding: 14px 16px calc(14px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--line);
  display: flex;
  align-items: center;
  gap: 14px;
}
.sheet-foot div {
  flex: 1;
  font-size: 18px;
}
.big {
  padding: 14px 28px;
  font-size: 17px;
}
</style>
