<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { api, clockTime, money, refreshShop, subscribe, useShopTitle, type Order } from '../api'
import { myTakeoutCodes } from '../takeout'

/**
 * 外帶訂單進度頁。
 * /takeout/:code 看單一張單（送出後跳來這裡，取餐號放最大）；
 * /takeout/mine 看這支手機點過的所有外帶單。
 */
const props = defineProps<{ code: string }>()
const isMine = computed(() => props.code === 'mine')

const shop = useShopTitle('外帶訂單進度')

const orders = ref<Order[]>([])
const loading = ref(true)
const error = ref('')

const STEPS = [
  { key: 'awaiting', label: '待店家接單' },
  { key: 'pending', label: '已接單' },
  { key: 'preparing', label: '製作中' },
  { key: 'done', label: '可取餐' },
]
/** 進度條走到第幾格；awaiting 沒出現過的話從「已接單」起算 */
function stepIndex(o: Order) {
  const i = STEPS.findIndex((s) => s.key === o.status)
  return i < 0 ? 0 : i
}

const STATUS_TEXT: Record<string, string> = {
  awaiting: '已送出，等待店家接單',
  pending: '店家已接單，排隊等製作',
  preparing: '廚房製作中',
  done: '餐點已完成，可以來取餐了',
  cancelled: '訂單已取消，請與店家聯絡',
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    await refreshShop()
    const codes = isMine.value ? myTakeoutCodes() : [props.code]
    if (codes.length === 0) {
      orders.value = []
      return
    }
    // 舊單可能已被清掉，個別失敗就跳過，不要讓整頁掛掉
    const results = await Promise.allSettled(codes.map((c) => api.takeoutOrder(c)))
    orders.value = results
      .filter((r): r is PromiseFulfilledResult<Order> => r.status === 'fulfilled')
      .map((r) => r.value)
    if (orders.value.length === 0 && !isMine.value) error.value = '查無此訂單，請確認連結是否正確'
  } catch (e) {
    error.value = e instanceof Error ? e.message : '載入失敗'
  } finally {
    loading.value = false
  }
}

watch(() => props.code, load, { immediate: true })

const unsubscribe = subscribe({
  'order:update': (o: Order) => {
    if (orders.value.some((x) => x.id === o.id)) load()
  },
})
onUnmounted(unsubscribe)
</script>

<template>
  <div class="page">
    <header class="top">
      <div>
        <div class="shop small">{{ shop?.name || '外帶訂餐' }}</div>
        <h1>{{ isMine ? '我的外帶訂單' : '訂單進度' }}</h1>
      </div>
      <RouterLink to="/takeout" class="again">再點一單</RouterLink>
    </header>

    <p v-if="loading" class="state muted">載入中…</p>
    <p v-else-if="error" class="state error">{{ error }}</p>
    <p v-else-if="orders.length === 0" class="state muted">
      這支手機還沒有外帶訂單記錄。
    </p>

    <main v-else class="list">
      <article v-for="o in orders" :key="o.id" class="card ticket">
        <div class="no">
          <span class="label">取餐號</span>
          <strong class="tabular">{{ o.pickup_no }}</strong>
        </div>

        <p class="status" :data-status="o.status">{{ STATUS_TEXT[o.status] }}</p>

        <ol v-if="o.status !== 'cancelled'" class="steps">
          <li v-for="(s, i) in STEPS" :key="s.key" :class="{ on: i <= stepIndex(o) }">{{ s.label }}</li>
        </ol>

        <dl class="meta">
          <div><dt>取餐時間</dt><dd>{{ o.pickup_at || '盡快（備餐約 ' + (shop?.takeoutLeadMinutes ?? 20) + ' 分鐘）' }}</dd></div>
          <div><dt>取餐人</dt><dd>{{ o.customer_name }}</dd></div>
          <div><dt>下單時間</dt><dd class="tabular">{{ clockTime(o.created_at) }}</dd></div>
          <div>
            <dt>付款</dt>
            <dd>{{ o.paid_at ? (o.payment === 'online' ? '已線上付款' : '已付款') : '到店取餐時付款' }}</dd>
          </div>
        </dl>

        <ul class="items">
          <li v-for="i in o.items" :key="i.id">
            <span>
              {{ i.name }}
              <em v-if="i.options.length" class="opt">{{ i.options.map((x) => x.name).join('／') }}</em>
              <em v-if="i.note" class="opt">備註：{{ i.note }}</em>
            </span>
            <span class="tabular muted">×{{ i.qty }}</span>
            <span class="tabular">{{ money(i.price * i.qty) }}</span>
          </li>
        </ul>

        <footer>
          <span>合計</span><strong class="tabular">{{ money(o.total) }}</strong>
        </footer>
      </article>

      <p v-if="shop" class="foot muted small">
        有問題請洽 {{ shop.name }}　{{ shop.phone }}<br />{{ shop.address }}
      </p>
    </main>
  </div>
</template>

<style scoped>
.page {
  max-width: 640px;
  margin: 0 auto;
  min-height: 100%;
  padding-bottom: 40px;
}
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px;
  background: linear-gradient(180deg, #a81c16, #8a140f);
  border-bottom: 3px solid var(--gold);
  color: #fff;
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
.again {
  flex: none;
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  text-decoration: none;
}
.state {
  padding: 48px 16px;
  text-align: center;
}
.error {
  color: #b3261e;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
}
.ticket {
  padding: 18px;
}
/* 取餐號要一眼看到，客人是拿這個號碼跟店員對的 */
.no {
  text-align: center;
  padding-bottom: 14px;
  border-bottom: 1px dashed var(--line);
}
.no .label {
  display: block;
  color: var(--muted);
  font-size: 13px;
  letter-spacing: 2px;
}
.no strong {
  display: block;
  font-size: 64px;
  line-height: 1.1;
  color: var(--brand);
  letter-spacing: 4px;
}
.status {
  margin: 14px 0;
  text-align: center;
  font-weight: 700;
  color: var(--warn);
}
.status[data-status='done'] {
  color: var(--ok);
}
.status[data-status='cancelled'] {
  color: #b3261e;
}
.steps {
  list-style: none;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  margin: 0 0 16px;
  padding: 0;
}
.steps li {
  padding-top: 10px;
  border-top: 4px solid var(--line);
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}
.steps li.on {
  border-top-color: var(--brand);
  color: var(--brand-dark);
  font-weight: 700;
}
.meta {
  margin: 0 0 14px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}
.meta div {
  background: var(--brand-soft);
  border-radius: 10px;
  padding: 8px 12px;
}
.meta dt {
  color: var(--muted);
  font-size: 12px;
}
.meta dd {
  margin: 2px 0 0;
  font-weight: 600;
}
.items {
  list-style: none;
  margin: 0;
  padding: 14px 0 0;
  border-top: 1px dashed var(--line);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.items li {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 12px;
  align-items: start;
}
.opt {
  display: block;
  font-style: normal;
  font-size: 13px;
  color: var(--muted);
}
.ticket footer {
  display: flex;
  justify-content: space-between;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
  font-size: 18px;
}
.foot {
  text-align: center;
  line-height: 1.8;
}
</style>
