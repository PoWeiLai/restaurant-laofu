import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./views/Home.vue') },
    { path: '/t/:tableId', component: () => import('./views/TableOrder.vue'), props: true },
    { path: '/kitchen', component: () => import('./views/Kitchen.vue') },
    { path: '/admin', component: () => import('./views/Admin.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
