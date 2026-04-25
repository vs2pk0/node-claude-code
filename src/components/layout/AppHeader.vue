<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { DownloadOutlined, PauseCircleOutlined, PlayCircleOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons-vue'
import { useAppState } from '@/composables/useAppState'

const route = useRoute()
const { draft, desktopMode, loading, serviceReady, serviceRunning, refreshAll, downloadSettings, persistConfig, startService, stopService } = useAppState()

const pageTitle = computed(() => String(route.meta.title ?? '运行概览'))
</script>

<template>
  <a-layout-header class="topbar">
    <div class="title-block">
      <h2>{{ pageTitle }}</h2>
      <a-tag color="processing">{{ draft?.Providers.length || 0 }} 家</a-tag>
    </div>
    <div class="toolbar">
      <a-button
        v-if="desktopMode && !serviceRunning"
        type="primary"
        ghost
        :loading="loading.starting"
        @click="startService"
      >
        <template #icon><PlayCircleOutlined /></template>
        启动
      </a-button>
      <a-button
        v-else-if="desktopMode"
        danger
        ghost
        :loading="loading.stopping"
        @click="stopService"
      >
        <template #icon><PauseCircleOutlined /></template>
        停止
      </a-button>
      <a-tooltip title="刷新">
        <a-button :loading="loading.config || loading.stats" :disabled="!serviceReady" @click="refreshAll">
          <template #icon><ReloadOutlined /></template>
        </a-button>
      </a-tooltip>
      <a-tooltip title="导出">
        <a-button :disabled="!serviceReady" @click="downloadSettings">
          <template #icon><DownloadOutlined /></template>
        </a-button>
      </a-tooltip>
      <a-button type="primary" :loading="loading.saving" :disabled="!serviceReady" @click="persistConfig">
        <template #icon><SaveOutlined /></template>
        保存
      </a-button>
    </div>
  </a-layout-header>
</template>
