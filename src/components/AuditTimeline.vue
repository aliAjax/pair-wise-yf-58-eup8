<script setup lang="ts">
import { useFlagStore } from '../stores/flags';

const store = useFlagStore();
</script>

<template>
  <a-card title="审计记录" size="small">
    <a-alert type="info" show-icon class="mb" message="幂等审计" description="成员写入失败后按原编号重试，同一动作（dedupKey）只记录一次，不会重复记审计。" />
    <a-timeline>
      <a-timeline-item v-for="item in store.auditLogs" :key="item.id" :color="item.action.includes('失败') || item.action.includes('作废') || item.action.includes('失效') || item.action.includes('回滚') || item.action.includes('停止') ? 'red' : 'blue'">
        <b>{{ item.at }} · {{ item.actor }}</b>
        <p>{{ item.action }}：{{ item.detail }} <a-tag v-if="item.dedupKey" color="default" class="ml">{{ item.dedupKey }}</a-tag></p>
      </a-timeline-item>
    </a-timeline>
  </a-card>
</template>

<style scoped>
.mb { margin-bottom: 18px; }
.ml { margin-left: 6px; }
</style>
