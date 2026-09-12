<script setup lang="ts">
import { computed } from 'vue'
import type { Shop } from '../api'

// 試用期提醒條：首頁、廚房看板、後台抬頭共用。沒設試用期（完整版）就什麼都不畫。
// 客人端刻意不掛這個，客人不需要知道店家在試用。
const props = defineProps<{ shop: Shop | null }>()

const trial = computed(() => props.shop?.trial ?? null)
/** 剩 3 天內就轉紅，老闆每天開看板時就會注意到 */
const urgent = computed(() => !!trial.value && (trial.value.expired || trial.value.daysLeft <= 3))
const text = computed(() => {
  const t = trial.value
  if (!t) return ''
  if (t.expired) return `試用期已於 ${t.until} 結束，客人端已停止接單，請聯絡系統提供者開通`
  if (t.daysLeft <= 1) return `試用期今天（${t.until}）到期，明天起客人端將停止接單`
  return `試用期至 ${t.until}，還剩 ${t.daysLeft} 天`
})
</script>

<template>
  <p v-if="trial" class="trial" :class="{ urgent }">{{ text }}</p>
</template>

<style scoped>
.trial {
  margin: 0 0 12px;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--gold-soft);
  color: var(--brand-dark);
  text-align: center;
  font-weight: 600;
}
/* 快到期／已到期：紅底白字，跟平常的金色提醒一眼分得出來 */
.trial.urgent {
  background: var(--brand);
  color: #fff;
}
</style>
