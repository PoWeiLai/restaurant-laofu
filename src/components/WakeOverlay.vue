<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { waking } from '../api'

/**
 * 伺服器喚醒等待畫面。
 * 雲端免費方案沒人用就會休眠，重新喚醒要數十秒。沒有這層提示，客人會以為系統壞了而一直重整，
 * 反而更慢。這裡只在等太久時才出現，正常情況（店裡本機、伺服器已醒）客人完全看不到。
 */
const seconds = ref(0)
let timer: ReturnType<typeof setInterval> | undefined

watch(waking, (on) => {
  clearInterval(timer)
  if (!on) return
  seconds.value = 0
  timer = setInterval(() => seconds.value++, 1000)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <Transition name="fade">
    <div v-if="waking" class="wake" role="status" aria-live="polite">
      <div class="bowl" aria-hidden="true">🍜</div>
      <h2>正在為您開爐…</h2>
      <p>系統休息中，喚醒需要幾十秒，請先別關掉頁面</p>
      <div class="bar"><span></span></div>
      <p class="count tabular">已等待 {{ seconds }} 秒</p>
    </div>
  </Transition>
</template>

<style scoped>
.wake {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
  background: rgba(244, 227, 217, 0.97);
  backdrop-filter: blur(3px);
}
.bowl {
  font-size: 56px;
  animation: steam 1.8s ease-in-out infinite;
}
@keyframes steam {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-8px);
  }
}
.wake h2 {
  color: var(--brand-dark);
}
.wake p {
  margin: 0;
  color: var(--muted);
}
.bar {
  width: min(260px, 70vw);
  height: 6px;
  margin-top: 6px;
  border-radius: 999px;
  background: var(--brand-soft);
  overflow: hidden;
}
.bar span {
  display: block;
  width: 40%;
  height: 100%;
  border-radius: 999px;
  background: var(--brand);
  animation: slide 1.2s ease-in-out infinite;
}
@keyframes slide {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(250%);
  }
}
.count {
  font-size: 13px;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .bowl,
  .bar span {
    animation: none;
  }
}
</style>
