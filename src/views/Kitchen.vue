<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import StaffGate from '../components/StaffGate.vue'
import { api, clockTime, subscribe, type Order } from '../api'

const orders = ref<Order[]>([])
const error = ref('')
const soundOn = ref(true)
const nowTick = ref(Date.now())

const pending = computed(() => orders.value.filter((o) => o.status === 'pending'))
const preparing = computed(() => orders.value.filter((o) => o.status === 'preparing'))

async function load() {
  try {
    orders.value = await api.kitchenOrders('active')
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : '載入失敗'
  }
}

async function move(order: Order, status: 'preparing' | 'done' | 'cancelled') {
  const previous = orders.value
  // 先反映在畫面上，廚房不必等網路
  orders.value = orders.value.filter((o) => o.id !== order.id || status === 'preparing')
  if (status === 'preparing') {
    orders.value = orders.value.map((o) => (o.id === order.id ? { ...o, status } : o))
  }
  try {
    await api.setOrderStatus(order.id, status)
  } catch (e) {
    orders.value = previous
    error.value = e instanceof Error ? e.message : '更新失敗'
  }
}

/** 新單提示音：用 WebAudio，不需音檔 */
function chime() {
  if (!soundOn.value) return
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain).connect(ctx.destination)
    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, ctx.currentTime)
    osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.15)
    gain.gain.setValueAtTime(0.25, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5)
    osc.start()
    osc.stop(ctx.currentTime + 0.5)
    setTimeout(() => ctx.close(), 800)
  } catch {
    /* 瀏覽器未允許自動播放時忽略 */
  }
}

/** 等候時間：超過 15 分鐘標紅提醒 */
function waited(iso: string) {
  const mins = Math.floor((nowTick.value - new Date(iso).getTime()) / 60000)
  return { mins, late: mins >= 15 }
}

const ready = ref(false)
/** 登入成功後才抓資料，並補抓登入前就已經送出的單 */
function start() {
  ready.value = true
  load()
}

let clockTimer: number
let refreshTimer: number
const unsubscribe = subscribe({
  'order:new': (o: Order) => {
    if (!ready.value) return
    // 可能已由重新整理帶進來，避免重複
    if (!orders.value.some((x) => x.id === o.id)) orders.value = [...orders.value, o]
    chime()
  },
  'order:update': () => ready.value && load(),
})

// 平板休眠、WiFi 斷線重連都可能漏掉推播，回到前景時補抓一次
const refetchOnWake = () => {
  if (ready.value && document.visibilityState === 'visible') load()
}

onMounted(() => {
  clockTimer = window.setInterval(() => (nowTick.value = Date.now()), 20000)
  refreshTimer = window.setInterval(refetchOnWake, 60000) // 每分鐘保險同步一次
  document.addEventListener('visibilitychange', refetchOnWake)
  window.addEventListener('online', refetchOnWake)
})
onUnmounted(() => {
  clearInterval(clockTimer)
  clearInterval(refreshTimer)
  document.removeEventListener('visibilitychange', refetchOnWake)
  window.removeEventListener('online', refetchOnWake)
  unsubscribe()
})
</script>

<template>
  <StaffGate @unlocked="start">
    <div class="kitchen">
      <header class="bar">
        <h1>廚房出單看板</h1>
        <div class="meta">
          <span class="count">待製作 {{ pending.length }}</span>
          <span class="count">製作中 {{ preparing.length }}</span>
          <button @click="soundOn = !soundOn">{{ soundOn ? '🔔 提示音開' : '🔕 提示音關' }}</button>
          <button @click="load">重新整理</button>
        </div>
      </header>

      <p v-if="error" class="err">{{ error }}</p>

      <div class="cols">
        <section>
          <h2>待製作</h2>
          <p v-if="!pending.length" class="empty muted">目前沒有新訂單</p>
          <article v-for="o in pending" :key="o.id" class="card ticket" :class="{ late: waited(o.created_at).late }">
            <header>
              <span class="table">{{ o.table_id }} 號桌</span>
              <span class="time">{{ clockTime(o.created_at) }}・等候 {{ waited(o.created_at).mins }} 分</span>
            </header>
            <ul>
              <li v-for="i in o.items" :key="i.id">
                <span class="qty tabular">{{ i.qty }}</span>
                <span class="nm">
                  {{ i.name }}
                  <b v-if="i.options.length" class="opt">{{ i.options.map((o2) => o2.name).join('／') }}</b>
                  <em v-if="i.note">{{ i.note }}</em>
                </span>
              </li>
            </ul>
            <div class="acts">
              <button class="btn-primary grow" @click="move(o, 'preparing')">開始製作</button>
              <button class="btn-danger" @click="move(o, 'cancelled')">取消</button>
            </div>
          </article>
        </section>

        <section>
          <h2>製作中</h2>
          <p v-if="!preparing.length" class="empty muted">沒有製作中的餐點</p>
          <article
            v-for="o in preparing"
            :key="o.id"
            class="card ticket doing"
            :class="{ late: waited(o.created_at).late }"
          >
            <header>
              <span class="table">{{ o.table_id }} 號桌</span>
              <span class="time">{{ clockTime(o.created_at) }}・等候 {{ waited(o.created_at).mins }} 分</span>
            </header>
            <ul>
              <li v-for="i in o.items" :key="i.id">
                <span class="qty tabular">{{ i.qty }}</span>
                <span class="nm">
                  {{ i.name }}
                  <b v-if="i.options.length" class="opt">{{ i.options.map((o2) => o2.name).join('／') }}</b>
                  <em v-if="i.note">{{ i.note }}</em>
                </span>
              </li>
            </ul>
            <div class="acts">
              <button class="btn-ok grow" @click="move(o, 'done')">完成出餐</button>
            </div>
          </article>
        </section>
      </div>
    </div>
  </StaffGate>
</template>

<style scoped>
.kitchen {
  min-height: 100vh;
  padding-bottom: 32px;
}
.bar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}
.meta {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.count {
  padding: 6px 14px;
  border-radius: 999px;
  background: var(--brand-soft);
  color: var(--brand-dark);
  font-weight: 600;
}
.err {
  margin: 12px 20px;
  color: #b3261e;
}
.cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  padding: 20px;
  align-items: start;
}
.cols section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.cols h2 {
  font-size: 18px;
}
.empty {
  padding: 32px;
  text-align: center;
  border: 1px dashed var(--line);
  border-radius: var(--radius);
}
.ticket {
  padding: 16px;
  border-left: 6px solid var(--brand);
}
.ticket.doing {
  border-left-color: var(--warn);
}
.ticket.late {
  background: #fff7f5;
  border-left-color: #d92d20;
}
.ticket > header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 12px;
}
.table {
  font-size: 26px;
  font-weight: 800;
}
.time {
  color: var(--muted);
  font-size: 14px;
}
.ticket ul {
  list-style: none;
  margin: 0 0 14px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ticket li {
  display: flex;
  gap: 14px;
  align-items: baseline;
  font-size: 20px;
}
.qty {
  min-width: 44px;
  text-align: center;
  font-weight: 800;
  background: var(--ink);
  color: #fff;
  border-radius: 8px;
  padding: 2px 6px;
  flex: none;
}
.nm .opt {
  display: block;
  font-size: 17px;
  font-weight: 700;
  color: var(--brand-dark);
}
.nm em {
  display: block;
  font-size: 15px;
  font-style: normal;
  color: #b3261e;
  font-weight: 600;
}
.acts {
  display: flex;
  gap: 10px;
}
.grow {
  flex: 1;
  padding: 14px;
  font-size: 17px;
}
@media (max-width: 780px) {
  .cols {
    grid-template-columns: 1fr;
  }
}
</style>
