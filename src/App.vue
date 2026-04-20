<script setup lang="ts">
import AppLayout from '@/components/layout/AppLayout.vue'
</script>

<template>
  <a-config-provider
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
