<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, type Table } from '../api'

const tables = ref<Table[]>([])
onMounted(async () => {
  tables.value = await api.tables()
})
</script>

<template>
  <div class="home">
    <h1>餐廳點餐系統</h1>
    <p class="muted">客人掃桌上的 QRcode 即可點餐，訂單直接進廚房看板。</p>

    <div class="cards">
      <RouterLink to="/kitchen" class="card tile">
        <h2>廚房看板</h2>
        <p class="muted">即時收單、標記製作中與完成出餐</p>
      </RouterLink>
      <RouterLink to="/admin" class="card tile">
        <h2>後台管理</h2>
        <p class="muted">改菜單、列印 QRcode、結帳與今日報表</p>
      </RouterLink>
    </div>

    <h2 class="sub">各桌點餐頁（測試用）</h2>
    <div class="tables">
      <RouterLink v-for="t in tables" :key="t.id" :to="`/t/${t.id}`" class="card table">
        {{ t.id }}
      </RouterLink>
    </div>
  </div>
</template>

<style scoped>
.home {
  max-width: 720px;
  margin: 0 auto;
  padding: 48px 20px;
}
h1 {
  font-size: 30px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
  margin: 24px 0 40px;
}
.tile {
  padding: 20px;
  text-decoration: none;
  color: inherit;
}
.tile p {
  margin: 6px 0 0;
}
.sub {
  font-size: 18px;
  margin-bottom: 12px;
}
.tables {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: 10px;
}
.table {
  display: grid;
  place-items: center;
  aspect-ratio: 1;
  font-size: 22px;
  font-weight: 700;
  text-decoration: none;
  color: inherit;
}
</style>
