<script setup lang="ts">
import { computed, ref } from 'vue';
import { useFlagStore } from '../stores/flags';
import type { ReleaseGroup } from '../stores/flags';
import { statusColor, memberStatusLabel, groupStatusLabel } from '../utils';

const store = useFlagStore();

const activeGroup = computed(() => store.activeGroup);
function placeholderCount(g: ReleaseGroup): number { return g.members.filter((m) => m.allocated > 0).length; }
const placeholders = computed(() => (activeGroup.value ? [...activeGroup.value.members].filter((m) => m.allocated > 0).sort((a, b) => a.order - b.order) : []));
const pending = computed(() => (activeGroup.value ? [...activeGroup.value.members].filter((m) => m.allocated === 0 && m.status !== 'invalid').sort((a, b) => a.order - b.order) : []));
const invalidMembers = computed(() => (activeGroup.value ? [...activeGroup.value.members].filter((m) => m.status === 'invalid').sort((a, b) => a.order - b.order) : []));
const releasing = ref(false);

const createOpen = ref(false);
const newName = ref('');
const newQuota = ref(100);
function createGroup() {
  if (!newName.value.trim()) return;
  store.createGroup(newName.value.trim(), newQuota.value);
  createOpen.value = false;
  newName.value = '';
  newQuota.value = 100;
}

const addOpen = ref(false);
const addFlagId = ref<string>();
const addQuota = ref(20);
function addMember() {
  if (!activeGroup.value || !addFlagId.value) return;
  store.addMember(activeGroup.value.id, addFlagId.value, addQuota.value);
  addOpen.value = false;
  addFlagId.value = undefined;
  addQuota.value = 20;
}

async function start() {
  if (!activeGroup.value) return;
  releasing.value = true;
  try { await store.startGroup(activeGroup.value.id); } finally { releasing.value = false; }
}
</script>

<template>
  <a-row :gutter="[18,18]">
    <a-col :xs="24" :lg="7">
      <a-card title="联动发布组" size="small">
        <a-button type="primary" block class="mb" @click="createOpen = true">新建联动组</a-button>
        <a-list :data-source="store.groups" bordered>
          <template #renderItem="{ item }">
            <a-list-item :class="{ selected: item.id === store.activeGroupId }" @click="store.selectGroup(item.id)">
              <a-list-item-meta>
                <template #title>
                  <a-space><span>{{ item.name }}</span><a-tag :color="statusColor(item.status)">{{ groupStatusLabel[item.status] }}</a-tag></a-space>
                </template>
                <template #description>
                  <code>{{ item.code }}</code> · 总名额 {{ item.totalQuota }} · 占位 {{ placeholderCount(item) }}/{{ item.members.length }}
                </template>
              </a-list-item-meta>
            </a-list-item>
          </template>
        </a-list>
      </a-card>
    </a-col>
    <a-col :xs="24" :lg="17">
      <template v-if="activeGroup">
        <a-card class="mb">
          <template #title>
            <a-space><span>{{ activeGroup.name }}</span><a-tag color="geekblue">{{ activeGroup.code }}</a-tag><a-tag :color="statusColor(activeGroup.status)">{{ groupStatusLabel[activeGroup.status] }}</a-tag></a-space>
          </template>
          <template #extra>
            <a-space>
              <a-tag color="default">总名额 {{ activeGroup.totalQuota }}</a-tag>
              <a-button :disabled="!['approved', 'failed'].includes(activeGroup.status)" :loading="releasing" @click="start">
                {{ activeGroup.status === 'failed' ? `按原编号 ${activeGroup.code} 重试` : '开始联动发布' }}
              </a-button>
            </a-space>
          </template>

          <a-alert v-if="activeGroup.status === 'voided'" type="error" show-icon class="mb" message="整组审批已作废" description="上游开关停用、回滚或规则改动后，依赖成员立即失效，整组审批一起作废。请先处理上游依赖，再重新审批发布。" />
          <a-alert v-else-if="activeGroup.status === 'failed'" type="warning" show-icon class="mb" message="发布失败，已回滚" description="成员写入失败后，已启动成员已恢复到启动前状态。可按原编号重试，审计不会重复记录。" />

          <a-descriptions bordered :column="{ xs: 1, md: 3 }" class="mb">
            <a-descriptions-item label="组编号"><code>{{ activeGroup.code }}</code><div class="hint">重试沿用原编号</div></a-descriptions-item>
            <a-descriptions-item label="总名额">
              <a-input-number :min="1" :max="1000" :value="activeGroup.totalQuota" :disabled="!['draft', 'voided', 'failed'].includes(activeGroup.status)" @change="(v: number | null) => v && store.setTotalQuota(activeGroup!.id, v)" />
            </a-descriptions-item>
            <a-descriptions-item label="审批">{{ activeGroup.approvals.join('、') || '待审批' }}</a-descriptions-item>
          </a-descriptions>

          <a-divider>名额分配（按顺序占位，超额留待放行）</a-divider>
          <div class="quota-bar">
            <a-tooltip v-for="m in placeholders" :key="m.id" :title="`${store.flagName(m.flagId)} 占用 ${m.allocated}`">
              <div class="quota-seg" :class="m.status" :style="{ width: `${(m.allocated / activeGroup.totalQuota) * 100}%` }">{{ m.allocated }}</div>
            </a-tooltip>
            <div v-if="!placeholders.length" class="quota-empty">暂无占位者</div>
          </div>
          <a-space wrap class="mt">
            <a-tag v-for="m in placeholders" :key="m.id" color="blue">占位者：{{ store.flagName(m.flagId) }} × {{ m.allocated }}</a-tag>
            <a-tag v-for="m in pending" :key="m.id" color="default">待放行：{{ store.flagName(m.flagId) }}（申请 {{ m.requestQuota }}）</a-tag>
            <a-tag v-for="m in invalidMembers" :key="m.id" color="red">已失效：{{ store.flagName(m.flagId) }}</a-tag>
          </a-space>

          <a-divider>成员</a-divider>
          <a-table :data-source="[...activeGroup.members].sort((a, b) => a.order - b.order)" :pagination="false" size="small" row-key="id">
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'order'">
                <a-space>
                  <a-button size="small" :disabled="record.order === 1" @click="store.moveMember(activeGroup.id, record.id, -1)">↑</a-button>
                  <a-button size="small" @click="store.moveMember(activeGroup.id, record.id, 1)">↓</a-button>
                  <span>{{ record.order }}</span>
                </a-space>
              </template>
              <template v-else-if="column.key === 'flag'">
                {{ store.flagName(record.flagId) }}
                <a-tag v-if="store.upstreamOf(record.flagId).length" color="orange" class="ml">依赖 {{ store.upstreamOf(record.flagId).map((f) => f.name).join('、') }}</a-tag>
              </template>
              <template v-else-if="column.key === 'request'">
                <a-input-number :min="1" :max="1000" :value="record.requestQuota" size="small" :disabled="!['draft', 'voided', 'failed'].includes(activeGroup.status)" @change="(v: number | null) => v && store.setRequestQuota(activeGroup!.id, record.id, v)" />
              </template>
              <template v-else-if="column.key === 'allocated'">{{ record.allocated }}</template>
              <template v-else-if="column.key === 'status'"><a-tag :color="statusColor(record.status)">{{ memberStatusLabel[record.status] ?? record.status }}</a-tag></template>
              <template v-else-if="column.key === 'fail'"><a-switch :checked="record.forceFail" @change="() => store.toggleForceFail(activeGroup!.id, record.id)" /></template>
              <template v-else-if="column.key === 'op'"><a-button size="small" danger type="text" :disabled="!['draft', 'voided', 'failed'].includes(activeGroup.status)" @click="store.removeMember(activeGroup!.id, record.id)">移除</a-button></template>
            </template>
          </a-table>
          <a-button class="mt" :disabled="!['draft', 'voided', 'failed'].includes(activeGroup.status)" @click="addOpen = true">添加成员</a-button>

          <a-divider>审批与发布</a-divider>
          <a-space>
            <a-button :disabled="activeGroup.approvals.includes('产品负责人') || !['draft', 'voided'].includes(activeGroup.status)" @click="store.approveGroup(activeGroup.id, '产品负责人')">产品审批</a-button>
            <a-button :disabled="activeGroup.approvals.includes('研发负责人') || !['draft', 'voided'].includes(activeGroup.status)" @click="store.approveGroup(activeGroup.id, '研发负责人')">研发审批</a-button>
            <a-tag v-if="activeGroup.status === 'voided'" color="red">作废后需重新审批</a-tag>
          </a-space>
        </a-card>
      </template>
    </a-col>
  </a-row>

  <a-modal v-model:open="createOpen" title="新建联动发布组" @ok="createGroup">
    <a-form layout="vertical">
      <a-form-item label="组名称"><a-input v-model:value="newName" placeholder="例如：首页改版联动组" /></a-form-item>
      <a-form-item label="总名额"><a-input-number v-model:value="newQuota" :min="1" :max="1000" /></a-form-item>
    </a-form>
  </a-modal>
  <a-modal v-model:open="addOpen" title="添加成员" @ok="addMember">
    <a-form layout="vertical">
      <a-form-item label="成员开关">
        <a-select v-model:value="addFlagId" :options="store.flags.map((f) => ({ value: f.id, label: `${f.name}（${f.key}）` }))" />
      </a-form-item>
      <a-form-item label="申请名额"><a-input-number v-model:value="addQuota" :min="1" :max="1000" /></a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.selected { background: #eef2ff; cursor: pointer; }
.mb { margin-bottom: 18px; }
.mt { margin-top: 14px; }
.ml { margin-left: 6px; }
.hint { color: #9ca3af; font-size: 12px; }
.quota-bar { display: flex; height: 26px; border-radius: 6px; overflow: hidden; background: #f3f4f6; }
.quota-seg { display: flex; align-items: center; justify-content: center; color: #fff; font-size: 12px; font-weight: 700; background: #6366f1; min-width: 2px; }
.quota-seg.pending { background: #d1d5db; }
.quota-seg.failed { background: #ef4444; }
.quota-seg.invalid { background: #f97316; }
.quota-empty { color: #9ca3af; font-size: 12px; padding: 4px 10px; }
:deep(.ant-table-cell) { vertical-align: middle; }
</style>
