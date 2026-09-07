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
export type OrderStatus = 'pending' | 'preparing' | 'done' | 'cancelled'
export interface Order {
  id: number
  session_id: number
  table_id: number
  status: OrderStatus
  note: string
  created_at: string
  items: OrderItem[]
  total: number
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

const PIN_KEY = 'restaurant.staffPin'
export const getPin = () => localStorage.getItem(PIN_KEY) || ''
export const setPin = (pin: string) => localStorage.setItem(PIN_KEY, pin)
export const clearPin = () => localStorage.removeItem(PIN_KEY)

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

  const res = await fetch(`/api${path}`, { method: options.method || 'GET', headers, body })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new ApiError(res.status, data?.error || `連線失敗（${res.status}）`)
  return data as T
}

export const api = {
  menu: () => request<Category[]>('/menu'),
  tables: () => request<Table[]>('/tables'),
  tableSession: (id: number) =>
    request<{ table: Table; session: unknown; orders: Order[]; total: number }>(`/tables/${id}/session`),
  placeOrder: (
    tableId: number,
    items: { itemId: number; qty: number; note?: string; choiceIds?: number[] }[],
    note = ''
  ) =>
    request<Order>('/orders', { method: 'POST', body: { tableId, items, note } }),

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

  qrcodes: () => request<{ baseURL: string; tables: QrTable[] }>('/admin/qrcodes'),
  bills: () => request<Bill[]>('/admin/bills'),
  closeBill: (sessionId: number, payment: string) =>
    request<{ ok: true; total: number }>(`/admin/sessions/${sessionId}/close`, { method: 'POST', body: { payment } }),
  report: () =>
    request<{ closedCount: number; revenue: number; topItems: { name: string; qty: number; amount: number }[] }>(
      '/admin/report'
    ),
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

export const money = (n: number) => `$${n.toLocaleString('zh-TW')}`
export const clockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })
