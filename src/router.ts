import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./views/Home.vue') },
    // 內用：掃桌上的 QRcode 進來，帶桌號
    {
      path: '/t/:tableId',
      component: () => import('./views/OrderPage.vue'),
      props: (route) => ({ mode: 'dine_in', tableId: route.params.tableId }),
    },
    // 外帶／遠端訂餐：不需要桌號，客人在哪裡都能點
    {
      path: '/takeout',
      component: () => import('./views/OrderPage.vue'),
      props: { mode: 'takeout' },
    },
    // /takeout/mine 是「這支手機的訂單」，要排在查詢碼前面才不會被當成 code
    { path: '/takeout/mine', component: () => import('./views/TakeoutStatus.vue'), props: { code: 'mine' } },
    { path: '/takeout/:code', component: () => import('./views/TakeoutStatus.vue'), props: true },
    { path: '/kitchen', component: () => import('./views/Kitchen.vue') },
    { path: '/admin', component: () => import('./views/Admin.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
