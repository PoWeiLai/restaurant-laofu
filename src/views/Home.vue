<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, useShopTitle, type Table } from '../api'

// 店名等資料都在後台「店家設定」裡，這裡不寫死
const shop = useShopTitle('線上點餐')
const tables = ref<Table[]>([])
onMounted(async () => {
  tables.value = await api.tables()
})
</script>

<template>
  <div class="home">
    <div class="sign">
      <h1>{{ shop?.name || '線上點餐' }}</h1>
      <p>{{ shop?.phone }}　{{ shop?.address }}</p>
    </div>

    <p v-if="shop?.trial" class="trial" :class="{ over: shop.trial.expired }">
      {{
        shop.trial.expired
          ? `試用期已於 ${shop.trial.until} 結束，客人端已停止接單`
          : `試用期至 ${shop.trial.until}，還剩 ${shop.trial.daysLeft} 天`
      }}
    </p>

    <p class="muted">客人掃桌上的 QRcode 即可點餐，訂單直接進廚房看板。</p>

    <div class="cards">
      <RouterLink to="/takeout" class="card tile out">
        <h2>外帶線上訂餐</h2>
        <p class="muted">客人在家先點好、時間到再來拿，不用現場排隊</p>
      </RouterLink>
      <RouterLink to="/kitchen" class="card tile">
        <h2>廚房看板</h2>
        <p class="muted">即時收單、標記製作中與完成出餐</p>
      </RouterLink>
      <RouterLink to="/admin" class="card tile">
        <h2>後台管理</h2>
        <p class="muted">改菜單、列印 QRcode、結帳與店家設定</p>
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
/* 招牌：紅底金框，對應店內門面 */
.sign {
  background: linear-gradient(180deg, #a81c16, #8a140f);
  border: 3px solid var(--gold);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 20px 24px;
  text-align: center;
  margin-bottom: 16px;
}
.sign h1 {
  font-size: 30px;
  color: var(--gold-soft);
  letter-spacing: 4px;
}
.sign p {
  margin: 6px 0 0;
  color: rgba(255, 255, 255, 0.82);
  font-size: 14px;
}
.trial {
  margin: 0 0 12px;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--gold-soft);
  color: var(--brand-dark);
  text-align: center;
  font-weight: 600;
}
.trial.over {
  background: var(--warn-soft);
  color: var(--warn);
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
  margin: 24px 0 40px;
}
/* 外帶是給客人用的入口，跟店員用的兩張分開視覺 */
.tile.out {
  border: 2px solid var(--brand);
  background: var(--brand-soft);
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
