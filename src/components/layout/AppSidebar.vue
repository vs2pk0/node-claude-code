<script setup lang="ts">
import { computed, h, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  BarChartOutlined,
  CloudServerOutlined,
  ImportOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
} from '@ant-design/icons-vue'
import type { MenuProps } from 'ant-design-vue'
import appLogo from '@/assets/app-logo.png'

defineProps<{
  uiUrl: string
  collapsed: boolean
}>()

const emit = defineEmits<{
  'update:collapsed': [value: boolean]
}>()

const route = useRoute()
const router = useRouter()

const selectedMenuKeys = computed({
  get: () => [String(route.name ?? 'dashboard')],
  set: (keys: string[]) => {
    const name = keys[0] || 'dashboard'
    if (name !== route.name) {
      router.push({ name })
    }
  },
})

const menuItems = computed<MenuProps['items']>(() => [
  {
    key: 'dashboard',
    icon: () => hIcon(BarChartOutlined),
    label: '仪表盘',
  },
  {
    key: 'settings',
    icon: () => hIcon(SettingOutlined),
    label: '服务配置',
  },
  {
    key: 'providers',
    icon: () => hIcon(CloudServerOutlined),
    label: 'Provider',
  },
  {
    key: 'io',
    icon: () => hIcon(ImportOutlined),
    label: '导入导出',
  },
])

function hIcon(component: Component) {
  return h(component)
}
</script>

<template>
  <a-layout-sider class="side" :collapsed="collapsed" :collapsed-width="72" width="232">
    <div class="brand">
      <div class="brand-mark">
        <img :src="appLogo" alt="Node Claude Code" class="brand-logo" />
      </div>
      <div v-if="!collapsed" class="brand-copy">
        <h1>Node Claude Code</h1>
        <p>{{ uiUrl || 'loading' }}</p>
      </div>
    </div>
    <a-menu
      v-model:selectedKeys="selectedMenuKeys"
      class="nav"
      mode="inline"
      :inline-collapsed="collapsed"
      :items="menuItems"
    />
    <div class="sidebar-footer" :class="{ 'is-collapsed': collapsed }">
      <a-tooltip :title="collapsed ? '展开菜单' : '折叠菜单'" placement="right">
        <a-button class="sidebar-toggle" type="text" @click="emit('update:collapsed', !collapsed)">
          <template #icon>
            <MenuUnfoldOutlined v-if="collapsed" />
            <MenuFoldOutlined v-else />
          </template>
        </a-button>
      </a-tooltip>
    </div>
  </a-layout-sider>
</template>
