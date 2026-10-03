<script setup lang="ts">
import { ref } from 'vue';
import { useFlagStore } from '../stores/flags';

const store = useFlagStore();
const fromId = ref<string>();
const toId = ref<string>();

function add() {
  if (!fromId.value || !toId.value) return;
  store.addDependency(fromId.value, toId.value);
  fromId.value = undefined;
  toId.value = undefined;
}
</script>

<template>
  <a-card title="依赖关系" size="small">
    <a-alert type="info" show-icon class="mb" message="联动规则" description="上游开关被停用、回滚或改动规则后，依赖它的下游开关立即失效，包含失效成员的联动组整组审批一起作废。" />
    <a-space wrap class="mb">
      <span>下游开关</span>
      <a-select v-model:value="fromId" style="width: 200px" placeholder="依赖方" :options="store.flags.map((f) => ({ value: f.id, label: f.name }))" />
      <span>依赖上游</span>
      <a-select v-model:value="toId" style="width: 200px" placeholder="被依赖方" :options="store.flags.map((f) => ({ value: f.id, label: f.name }))" />
      <a-button type="primary" @click="add">添加依赖</a-button>
    </a-space>
    <a-table :data-source="store.dependencies" :pagination="false" size="small" row-key="id">
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'from'">{{ store.flagName(record.fromId) }}</template>
        <template v-else-if="column.key === 'arrow'">依赖 →</template>
        <template v-else-if="column.key === 'to'">{{ store.flagName(record.toId) }}</template>
        <template v-else-if="column.key === 'op'"><a-button size="small" danger type="text" @click="store.removeDependency(record.id)">移除</a-button></template>
      </template>
    </a-table>
  </a-card>
</template>

<style scoped>
.mb { margin-bottom: 18px; }
</style>
