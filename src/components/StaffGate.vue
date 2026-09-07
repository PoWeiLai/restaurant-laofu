<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, clearPin, getPin, setPin } from '../api'

/** 解鎖後才通知父層載入資料——否則會在登入前就打 API 被擋 401 */
const emit = defineEmits<{ unlocked: [] }>()

const unlocked = ref(false)
const checking = ref(true)
const pin = ref('')
const error = ref('')
const busy = ref(false)

function unlock() {
  unlocked.value = true
  emit('unlocked')
}

// 開頁時先驗證存起來的密碼，密碼被改過就退回登入畫面
onMounted(async () => {
  const saved = getPin()
  if (!saved) {
    checking.value = false
    return
  }
  try {
    await api.login(saved)
    unlock()
  } catch {
    clearPin()
  } finally {
    checking.value = false
  }
})

async function login() {
  busy.value = true
  error.value = ''
  try {
    await api.login(pin.value)
    setPin(pin.value)
    unlock()
  } catch (e) {
    clearPin()
    error.value = e instanceof Error ? e.message : '登入失敗'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <slot v-if="unlocked" />
  <div v-else class="gate">
    <p v-if="checking" class="muted">檢查登入狀態…</p>
    <form v-else class="card box" @submit.prevent="login">
      <h1>店員登入</h1>
      <p class="muted">此頁面提供廚房與後台使用，請輸入店員密碼。</p>
      <input v-model="pin" type="password" inputmode="numeric" placeholder="店員密碼" autofocus />
      <p v-if="error" class="err">{{ error }}</p>
      <button class="btn-primary" type="submit" :disabled="busy || !pin">
        {{ busy ? '驗證中…' : '登入' }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.gate {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}
.box {
  width: min(360px, 100%);
  padding: 28px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.err {
  margin: 0;
  color: #b3261e;
}
</style>
