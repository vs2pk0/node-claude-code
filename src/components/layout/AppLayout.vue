<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { RouterView } from 'vue-router'
import { useAppState } from '@/composables/useAppState'
import AppHeader from './AppHeader.vue'
import AppSidebar from './AppSidebar.vue'

const { loading, uiUrl, initializeApp, stopStatsPolling } = useAppState()
const sidebarCollapsed = ref(false)
const shellStyle = computed(() => ({
  '--sidebar-width': sidebarCollapsed.value ? '72px' : '232px',
}))

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
        <RouterView />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>
