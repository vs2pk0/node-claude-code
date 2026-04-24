<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { RouterView } from 'vue-router'
import { useAppState } from '@/composables/useAppState'
import AppHeader from './AppHeader.vue'
import AppSidebar from './AppSidebar.vue'

const {
  desktopService,
  loading,
  serviceReady,
  startupHost,
  startupPort,
  uiUrl,
  initializeApp,
  openConfigDirectory,
  saveStartupConfig,
  startService,
  stopStatsPolling,
} = useAppState()
const sidebarCollapsed = ref(false)
const shellStyle = computed(() => ({
  '--sidebar-width': sidebarCollapsed.value ? '72px' : '232px',
}))
const startupMessage = computed(() => {
  const configured = desktopService.value?.configured
  if (!configured) {
    return '本地服务尚未启动'
  }

  return `本地服务当前未启动，配置地址为 ${configured.host}:${configured.port}`
})

onMounted(() => {
  initializeApp()
})

onUnmounted(() => {
  stopStatsPolling()
})
</script>

<template>
  <a-layout class="app-shell" :style="shellStyle">
    <AppSidebar v-model:collapsed="sidebarCollapsed" :ui-url="uiUrl" />
    <a-layout class="main-shell">
      <AppHeader />
      <a-layout-content class="content" :class="{ 'is-loading': loading.config }">
        <section v-if="!serviceReady" class="panel startup-panel">
          <a-card class="tool-card startup-card">
            <template #title>本地服务</template>
            <p>{{ startupMessage }}</p>
            <p>可以先调整启动地址，再启动服务喵～</p>
            <div class="startup-form">
              <a-form-item label="Host">
                <a-input v-model:value="startupHost" />
              </a-form-item>
              <a-form-item label="Port">
                <a-input-number v-model:value="startupPort" :min="1" :max="65535" class="full-input" />
              </a-form-item>
            </div>
            <div class="startup-actions">
              <a-button @click="openConfigDirectory">打开配置文件夹</a-button>
              <a-button @click="saveStartupConfig">保存启动地址</a-button>
              <a-button type="primary" :loading="loading.starting" @click="startService">启动本地服务</a-button>
            </div>
          </a-card>
        </section>
        <RouterView v-else />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>
