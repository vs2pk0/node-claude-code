import { createRouter, createWebHistory } from 'vue-router'
import CodexPage from '@/pages/CodexPage.vue'
import DashboardPage from '@/pages/DashboardPage.vue'
import ImportExportPage from '@/pages/ImportExportPage.vue'
import ProvidersPage from '@/pages/ProvidersPage.vue'
import SettingsPage from '@/pages/SettingsPage.vue'
import UsageStatsPage from '@/pages/UsageStatsPage.vue'

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'dashboard',
      component: DashboardPage,
      meta: {
        title: '运行概览',
      },
    },
    {
      path: '/settings',
      name: 'settings',
      component: SettingsPage,
      meta: {
        title: '服务配置',
      },
    },
    {
      path: '/providers',
      name: 'providers',
      component: ProvidersPage,
      meta: {
        title: 'Provider 管理',
      },
    },
    {
      path: '/codex',
      name: 'codex',
      component: CodexPage,
      meta: {
        title: 'Codex 代理',
      },
    },
    {
      path: '/usage',
      name: 'usage',
      component: UsageStatsPage,
      meta: {
        title: '调用统计',
      },
    },
    {
      path: '/io',
      name: 'io',
      component: ImportExportPage,
      meta: {
        title: '配置文件',
      },
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
})
