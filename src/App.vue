<script setup lang="ts">
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import AppLayout from '@/components/layout/AppLayout.vue'
</script>

<template>
  <a-config-provider
    :locale="zhCN"
    :theme="{
      token: {
        borderRadius: 6,
        colorPrimary: '#2f6f6d',
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
      },
    }"
  >
    <AppLayout />
  </a-config-provider>
</template>
