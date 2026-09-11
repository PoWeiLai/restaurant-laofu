import { ref, watch } from 'vue'

export interface OptionChoice {
  id: number
  group_id: number
  name: string
  price_delta: number
  sort: number
}
export interface OptionGroup {
  id: number
  key: string
  name: string
  mode: 'single' | 'multi'
  required: number
  sort: number
  choices: OptionChoice[]
}
export interface MenuItem {
  id: number
  category_id: number
  name: string
  description: string
  price: number
  image: string
  available: number
  sort: number
  optionGroups: OptionGroup[]
}
export interface ChosenOption {
  group: string
  name: string
  price_delta: number
}
export interface Category {
  id: number
  name: string
  sort: number
  items: MenuItem[]
}
export interface OrderItem {
  id: number
  order_id: number
  item_id: number | null
  name: string
  price: number
  qty: number
  note: string
  options: ChosenOption[]
}
/** awaiting 只有外帶會用到：店家開了「先確認再下廚」時，單子停在這一關等店員接單 */
export type OrderStatus = 'awaiting' | 'pending' | 'preparing' | 'done' | 'cancelled'
export type OrderType = 'dine_in' | 'takeout'
export interface Order {
  id: number
  type: OrderType
  /** 外帶單沒有桌次與桌號，兩個都是 null */
  session_id: number | null
  table_id: number | null
  status: OrderStatus
  note: string
  created_at: string
  items: OrderItem[]
  total: number
  /* 以下只有外帶單有值 */
  pickup_no: string
  track_code: string
  customer_name: string
  customer_phone: string
  /** 預約取餐時間 HH:MM，空字串代表盡快 */
  pickup_at: string
  paid_at: string | null
  payment: string | null
}

export interface Shop {
  name: string
  phone: string
  address: string
  takeoutEnabled: boolean
  takeoutLeadMinutes: number
  /** 外帶是否開放線上先付款 */
  paymentOnline: boolean
  /** mock = 示範用模擬付款，不會真的收錢 */
  paymentProvider: string
  /** 沒設試用期就是 null（完整版） */
  trial: { until: string; daysLeft: number; expired: boolean } | null
}
export interface Table {
  id: number
  name: string
  seats: number
}
export interface Bill {
  id: number
  table_id: number
  opened_at: string
  closed_at: string | null
  table: Table
  orders: Order[]
  total: number
}
export interface QrTable extends Table {
  url: string
  qr: string
}
export interface Settings {
  shop_name: string
  shop_phone: string
  shop_address: string
  takeout_enabled: string
  takeout_lead_minutes: string
  takeout_confirm_first: string
  payment_online: string
  payment_provider: string
}

const PIN_KEY = 'restaurant.staffPin'
export const getPin = () => localStorage.getItem(PIN_KEY) || ''
export const setPin = (pin: string) => localStorage.setItem(PIN_KEY, pin)
export const clearPin = () => localStorage.removeItem(PIN_KEY)

/**
 * 伺服器休眠喚醒中。
 * Render 免費方案沒流量會休眠，第一個請求要等數十秒；超過 2.5 秒還沒回來就打開等待畫面，
 * 讓客人知道是在喚醒而不是當掉。
 */
export const waking = ref(false)
let inflight = 0
let wakeTimer: ReturnType<typeof setTimeout> | undefined

function beginRequest() {
  inflight++
  if (wakeTimer === undefined) wakeTimer = setTimeout(() => (waking.value = true), 2500)
}
function endRequest() {
  if (--inflight > 0) return
  clearTimeout(wakeTimer)
  wakeTimer = undefined
  waking.value = false
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {}
  const pin = getPin()
  if (pin) headers['x-staff-pin'] = pin

  let body: BodyInit | undefined
  if (options.body instanceof FormData) {
    body = options.body
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }

  beginRequest()
  try {
    const res = await fetch(`/api${path}`, { method: options.method || 'GET', headers, body })
    const text = await res.text()
    const data = text ? JSON.parse(text) : null
    if (!res.ok) throw new ApiError(res.status, data?.error || `連線失敗（${res.status}）`)
    return data as T
  } finally {
    endRequest()
  }
}

export interface CartPayload {
  itemId: number
  qty: number
  note?: string
  choiceIds?: number[]
}

export const api = {
  shop: () => request<Shop>('/shop'),
  menu: () => request<Category[]>('/menu'),
  tables: () => request<Table[]>('/tables'),
  tableSession: (id: number) =>
    request<{ table: Table; session: unknown; orders: Order[]; total: number }>(`/tables/${id}/session`),
  placeOrder: (tableId: number, items: CartPayload[], note = '') =>
    request<Order>('/orders', { method: 'POST', body: { type: 'dine_in', tableId, items, note } }),

  /** 外帶／遠端訂餐：不需要桌號，改留取餐人與電話 */
  placeTakeout: (
    customer: { name: string; phone: string },
    items: CartPayload[],
    pickupAt = '',
    note = ''
  ) => request<Order>('/orders', { method: 'POST', body: { type: 'takeout', customer, items, pickupAt, note } }),
  takeoutOrder: (code: string) => request<Order>(`/takeout/${code}`),
  payTakeoutOnline: (code: string) => request<Order>(`/takeout/${code}/pay-online`, { method: 'POST' }),

  login: (pin: string) => request<{ ok: true }>('/staff/login', { method: 'POST', body: { pin } }),

  kitchenOrders: (scope: 'active' | 'all' = 'active') => request<Order[]>(`/kitchen/orders?scope=${scope}`),
  setOrderStatus: (id: number, status: OrderStatus) =>
    request<Order>(`/orders/${id}/status`, { method: 'PATCH', body: { status } }),

  addCategory: (name: string) => request<Category>('/admin/categories', { method: 'POST', body: { name } }),
  renameCategory: (id: number, name: string) =>
    request<Category>(`/admin/categories/${id}`, { method: 'PATCH', body: { name } }),
  deleteCategory: (id: number) => request<{ ok: true }>(`/admin/categories/${id}`, { method: 'DELETE' }),

  addItem: (body: { categoryId: number; name: string; price: number; description?: string; image?: string }) =>
    request<MenuItem>('/admin/menu-items', { method: 'POST', body }),
  updateItem: (id: number, body: Partial<{ name: string; price: number; description: string; image: string; available: boolean; categoryId: number }>) =>
    request<MenuItem>(`/admin/menu-items/${id}`, { method: 'PATCH', body }),
  deleteItem: (id: number) => request<{ ok: true }>(`/admin/menu-items/${id}`, { method: 'DELETE' }),
  bulkImport: (text: string, replace: boolean) =>
    request<{ ok: true; count: number }>('/admin/menu/bulk', { method: 'POST', body: { text, replace } }),
  upload: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return request<{ url: string }>('/admin/upload', { method: 'POST', body: fd })
  },

  qrcodes: () =>
    request<{ baseURL: string; tables: QrTable[]; takeout: { url: string; qr: string } }>('/admin/qrcodes'),
  bills: () => request<Bill[]>('/admin/bills'),
  closeBill: (sessionId: number, payment: string) =>
    request<{ ok: true; total: number }>(`/admin/sessions/${sessionId}/close`, { method: 'POST', body: { payment } }),

  takeoutOrders: () => request<Order[]>('/admin/takeout'),
  payTakeout: (orderId: number, payment: string) =>
    request<Order>(`/admin/orders/${orderId}/pay`, { method: 'POST', body: { payment } }),

  settings: () => request<Settings>('/admin/settings'),
  saveSettings: (patch: Partial<Settings>) =>
    request<Settings>('/admin/settings', { method: 'PATCH', body: patch }),

  report: () =>
    request<{
      closedCount: number
      takeoutCount: number
      dineInRevenue: number
      takeoutRevenue: number
      revenue: number
      topItems: { name: string; qty: number; amount: number }[]
    }>('/admin/report'),
}

/** 下載整份營運資料備份，交給店家自己保存 */
export async function downloadBackup() {
  const res = await fetch('/api/admin/backup', { headers: { 'x-staff-pin': getPin() } })
  if (!res.ok) {
    const text = await res.text()
    const data = text ? JSON.parse(text) : null
    throw new ApiError(res.status, data?.error || `備份失敗（${res.status}）`)
  }
  const name =
    res.headers.get('content-disposition')?.match(/filename="?([^";]+)/)?.[1] || 'restaurant-backup.db'
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/** 訂閱伺服器事件；回傳取消訂閱函式 */
export function subscribe(handlers: Record<string, (data: any) => void>): () => void {
  const es = new EventSource('/api/events')
  for (const [type, fn] of Object.entries(handlers)) {
    es.addEventListener(type, (e) => fn(JSON.parse((e as MessageEvent).data || '{}')))
  }
  return () => es.close()
}

/**
 * 全站共用的店家資料。
 *
 * 店名會出現在每一頁的抬頭和瀏覽器分頁標題上，而且是店家在後台自己填的，
 * 所以集中在這裡載一次給各頁共用，不要每頁各寫一份、更不要寫死在樣板裡。
 * （伺服器送出 HTML 時也會把店名填進 <title>，那是給不會跑 JS 的 LINE／FB 連結預覽爬蟲看的。）
 */
const shopRef = ref<Shop | null>(null)
let shopLoading: Promise<unknown> | null = null

export function refreshShop() {
  shopLoading = api.shop().then((s) => (shopRef.value = s))
  return shopLoading.catch(() => undefined) // 載不到就維持原樣，不要讓整頁掛掉
}

/** 取得店家資料，順便把瀏覽器分頁標題設成「店名 — 這一頁是什麼」 */
export function useShopTitle(pageName = '線上點餐') {
  if (!shopLoading) refreshShop()
  watch(
    shopRef,
    (s) => {
      if (s) document.title = `${s.name} — ${pageName}`
    },
    { immediate: true }
  )
  return shopRef
}

export const money = (n: number) => `$${n.toLocaleString('zh-TW')}`
export const clockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })
