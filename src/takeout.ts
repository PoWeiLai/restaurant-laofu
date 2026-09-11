/**
 * 客人自己的外帶訂單記錄。
 * 外帶沒有登入機制，所以把伺服器發的查詢碼存在這支手機上，客人回頭才找得到自己的單。
 * 只存查詢碼，不存個資。
 */
const KEY = 'restaurant.takeoutCodes'
const MAX = 10

export function myTakeoutCodes(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((c) => typeof c === 'string') : []
  } catch {
    return [] // 無痕模式或被瀏覽器擋掉時，當作沒有記錄
  }
}

export function rememberTakeout(code: string) {
  try {
    const next = [code, ...myTakeoutCodes().filter((c) => c !== code)].slice(0, MAX)
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* 存不進去就算了，取餐號畫面照樣看得到 */
  }
}
