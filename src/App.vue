<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { message } from 'ant-design-vue';
import {
  useFlagStore, isEffective, downstreamOf,
  type FeatureFlag, type ReleaseGroup, type MemberAllocation
} from './stores/flags';

const store = useFlagStore();
const online = useOnline();

/* -------------------------------- 视图辅助 -------------------------------- */

const STATUS_META: Record<string, { label: string; color: string }> = {
  draft: { label: '草稿', color: 'gold' },
  approved: { label: '已审批', color: 'blue' },
  rolling: { label: '放量中', color: 'green' },
  scheduled: { label: '定时中', color: 'cyan' },
  stopped: { label: '已停用', color: 'red' },
  'rolled-back': { label: '已回滚', color: 'red' },
  invalidated: { label: '联动失效', color: 'volcano' },
  releasing: { label: '发布中', color: 'processing' },
  released: { label: '已发布', color: 'green' },
  partial: { label: '待重试', color: 'orange' }
};
const tagOf = (s: string) => STATUS_META[s] ?? { label: s, color: 'default' };

const active = computed(() => store.active);
const group = computed(() => store.activeGroup);
const allocation = computed(() => (group.value ? store.allocationFor(group.value) : null));
const admittedRows = computed(() => allocation.value?.rows.filter((r) => r.admitted) ?? []);
const waitingRows = computed(() => allocation.value?.rows.filter((r) => !r.admitted) ?? []);
const effective = (f: FeatureFlag) => isEffective(f, store.flags);
const downstream = computed(() => (active.value ? downstreamOf(active.value.id, store.flags) : []));
const upstreams = computed(() => active.value
  ? active.value.dependsOn.map((id) => store.flags.find((f) => f.id === id)).filter((f): f is FeatureFlag => !!f)
  : []);

/** 依赖编辑候选：不能选自己，也不能选自己的下游（会成环） */
const depOptions = computed(() => {
  if (!active.value) return [];
  const banned = new Set([active.value.id, ...downstream.value.map((f) => f.id)]);
  return store.flags.filter((f) => !banned.has(f.id)).map((f) => ({ value: f.id, label: `${f.name}（${f.key}）` }));
});
function onDepChange(ids: string[]) {
  if (active.value && !store.setDependencies(active.value, ids)) message.error('该依赖会形成循环，已忽略');
}

function flagOf(id: string) { return store.flags.find((f) => f.id === id); }
function memberState(row: MemberAllocation) {
  const f = row.flag;
  if (!f) return { color: 'default', text: '开关缺失' };
  if (!row.admitted) return { color: 'orange', text: '待放行' };
  if (f.status === 'invalidated') return { color: 'volcano', text: `联动失效：${f.invalidReason?.sourceKey}${f.invalidReason?.event}` };
  if (!effective(f)) return { color: 'red', text: '上游未生效' };
  return { color: 'green', text: '可放行' };
}
const launchDisabled = computed(() => {
  const g = group.value;
  if (!g || g.status === 'releasing' || !admittedRows.value.length) return true;
  if (g.status === 'partial') return g.approvals.length < 2;
  return g.approvals.length < 2;
});
function launchLabel(g: ReleaseGroup | undefined) {
  if (!g) return '';
  if (g.status === 'releasing') return '正在按顺序写入…';
  if (g.status === 'partial') return '按原编号重试';
  return '启动联动发布';
}
async function launch() {
  await store.launchGroup();
  const r = group.value?.lastResult;
  if (r) (r.ok ? message.success : message.warning)(r.detail);
}

/* -------------------------------- 新建开关 -------------------------------- */

const flagOpen = ref(false);
const flagSchema = toTypedSchema(z.object({
  name: z.string().min(2, '至少 2 个字符'),
  key: z.string().regex(/^[a-z0-9-]+$/, '仅支持小写字母、数字和连字符')
}));
const flagForm = useForm({ validationSchema: flagSchema });
const flagErrors = flagForm.errors;
const [flagName] = flagForm.defineField('name');
const [flagKey] = flagForm.defineField('key');
const newDeps = ref<string[]>([]);
const submitFlag = flagForm.handleSubmit((values) => {
  store.createFlag(values.name, values.key, newDeps.value);
  message.success(`开关 ${values.key} 已创建`);
  flagOpen.value = false;
  newDeps.value = [];
  flagForm.resetForm();
});

/* -------------------------------- 新建发布组 ------------------------------- */

const groupOpen = ref(false);
const groupForm = reactive({ name: '', quota: 60 });
function submitGroup() {
  if (groupForm.name.trim().length < 2) { message.error('组名至少 2 个字符'); return; }
  store.createGroup(groupForm.name.trim(), groupForm.quota);
  message.success('发布组已创建，请添加成员');
  groupOpen.value = false;
  groupForm.name = '';
  groupForm.quota = 60;
}

/* --------------------------------- 成员管理 -------------------------------- */

const addFlagId = ref<string>();
const addWant = ref(10);
function addMember() {
  if (!addFlagId.value) return;
  store.addMember(addFlagId.value, addWant.value);
  addFlagId.value = undefined;
}

/* -------------------------------- 规则与模拟 ------------------------------- */

const simulation = ref<{ hit: boolean; reason: string } | null>(null);
const user = reactive({ id: 'user-1042', region: '上海', appVersion: '8.3.0', authenticated: true });
function simulate() { if (active.value) simulation.value = store.simulateHit(user); }

function resetDemo() {
  localStorage.removeItem('yf58-flag-state');
  location.reload();
}
</script>

<template>
  <a-config-provider>
    <a-layout class="app-shell">
      <a-layout-header class="topbar">
        <div>
          <div class="eyebrow">FEATURE FLAG ORCHESTRATION / PORT 62023</div>
          <h1>{{ $t('title') }}</h1>
        </div>
        <a-space wrap>
          <a-tag :color="online ? 'green' : 'orange'">{{ online ? '控制面在线' : '离线草稿' }}</a-tag>
          <a-button @click="flagOpen = true">新建功能开关</a-button>
          <a-button type="primary" @click="groupOpen = true">新建联动发布组</a-button>
          <a-button ghost @click="resetDemo">重置演示数据</a-button>
        </a-space>
      </a-layout-header>

      <a-layout-content class="content">
        <a-alert v-if="!online" type="warning" show-icon class="mb"
          message="离线状态" description="变更暂存浏览器，恢复网络后仍需完成审批才能发布。" />

        <a-row :gutter="[18, 18]">
          <!-- 左栏：开关与依赖 -->
          <a-col :xs="24" :lg="8" :xl="7">
            <a-card size="small" title="功能开关">
              <a-list :data-source="store.flags" bordered size="small">
                <template #renderItem="{ item }">
                  <a-list-item :class="{ selected: item.id === store.activeId }" @click="store.select(item.id)">
                    <a-list-item-meta>
                      <template #title>
                        <a-space size="small" wrap>
                          <a-badge v-if="item.enabled" status="success" />
                          <span>{{ item.name }}</span>
                          <a-tag :color="tagOf(item.status).color">{{ tagOf(item.status).label }}</a-tag>
                        </a-space>
                      </template>
                      <template #description>
                        <code>{{ item.key }}</code> · {{ item.rollout }}%
                        <a-tooltip v-if="item.invalidReason" :title="`被 ${item.invalidReason.sourceKey} 的「${item.invalidReason.event}」联动失效`">
                          <a-tag color="volcano" class="mt4">因 {{ item.invalidReason.sourceKey }} {{ item.invalidReason.event }} 失效</a-tag>
                        </a-tooltip>
                      </template>
                    </a-list-item-meta>
                  </a-list-item>
                </template>
              </a-list>
            </a-card>

            <a-card v-if="active" size="small" class="mt" title="依赖关系">
              <div class="dep-box">
                <div class="dep-col">
                  <div class="dep-hint">上游（需先生效）</div>
                  <a-tag v-for="up in upstreams" :key="up.id" :color="effective(up) ? 'green' : 'red'" class="dep-tag">
                    {{ up.key }}{{ effective(up) ? '' : '（未生效）' }}
                  </a-tag>
                  <span v-if="!upstreams.length" class="dep-hint">无上游</span>
                </div>
                <div class="dep-arrow">⇣</div>
                <div class="dep-self"><code>{{ active.key }}</code></div>
                <div class="dep-arrow">⇣</div>
                <div class="dep-col">
                  <div class="dep-hint">下游（本开关停用/回滚/改规则时立即联动失效，共 {{ downstream.length }} 个）</div>
                  <a-tag v-for="dn in downstream" :key="dn.id"
                    :color="dn.status === 'invalidated' ? 'volcano' : effective(dn) ? 'green' : 'default'" class="dep-tag">
                    {{ dn.key }}
                  </a-tag>
                  <span v-if="!downstream.length" class="dep-hint">无下游</span>
                </div>
              </div>
            </a-card>

            <a-card size="small" class="mt" title="规则命中模拟">
              <a-form layout="vertical">
                <a-form-item label="用户 ID"><a-input v-model:value="user.id" /></a-form-item>
                <a-row :gutter="8">
                  <a-col :span="12"><a-form-item label="地区"><a-input v-model:value="user.region" /></a-form-item></a-col>
                  <a-col :span="12"><a-form-item label="版本"><a-input v-model:value="user.appVersion" /></a-form-item></a-col>
                </a-row>
                <a-checkbox v-model:checked="user.authenticated">已登录</a-checkbox>
                <a-button type="primary" block class="mt" @click="simulate">{{ $t('simulate') }}</a-button>
              </a-form>
              <a-alert v-if="simulation" class="mt" :type="simulation.hit ? 'success' : 'info'" show-icon
                :message="simulation.hit ? '命中新功能' : '未命中'" :description="simulation.reason" />
            </a-card>
          </a-col>

          <!-- 右栏：开关详情 + 发布组 -->
          <a-col :xs="24" :lg="16" :xl="17">
            <!-- 发布组切换 -->
            <a-card size="small" class="mb" :body-style="{ paddingBottom: '8px' }">
              <a-radio-group button-style="solid" :value="store.activeGroupId" @change="(e: { target: { value: string } }) => store.selectGroup(e.target.value)">
                <a-radio-button v-for="g in store.groups" :key="g.id" :value="g.id">
                  {{ g.name }} <a-tag :color="tagOf(g.status).color" style="margin-left:6px">{{ tagOf(g.status).label }}</a-tag>
                </a-radio-button>
              </a-radio-group>
            </a-card>

            <template v-if="group">
              <a-card size="small" class="mb">
                <template #title>
                  <a-space>
                    <span>联动发布组 · {{ group.name }}</span>
                    <a-tag :color="tagOf(group.status).color">{{ tagOf(group.status).label }}</a-tag>
                    <a-tag v-if="group.launchNo" color="purple">发布会话 #{{ group.launchNo }}</a-tag>
                  </a-space>
                </template>
                <template #extra>
                  <a-space>
                    <a-button :disabled="group.approvals.includes('产品负责人') || group.status === 'releasing'"
                      @click="store.approveGroup('产品负责人')">产品审批</a-button>
                    <a-button :disabled="group.approvals.includes('研发负责人') || group.status === 'releasing'"
                      @click="store.approveGroup('研发负责人')">研发审批</a-button>
                    <a-button type="primary" :loading="group.status === 'releasing'" :disabled="launchDisabled" @click="launch">
                      {{ launchLabel(group) }}
                    </a-button>
                  </a-space>
                </template>

                <!-- 总名额与占用 -->
                <a-row :gutter="16" align="middle">
                  <a-col flex="320px">
                    <div class="quota-line">
                      组总名额
                      <a-slider :value="group.totalQuota" :min="0" :max="100" :step="5" style="width:180px;margin:0 10px"
                        :disabled="group.status === 'releasing'" @change="(v: number) => store.setGroupQuota(v)" />
                      <b>{{ group.totalQuota }}%</b>
                    </div>
                  </a-col>
                  <a-col flex="auto">
                    <a-progress :percent="allocation ? Math.round(allocation.used / allocation.total * 100) : 0"
                      :status="allocation && allocation.used >= allocation.total ? 'success' : 'active'" size="small"
                      :format="() => `已按顺序占用 ${allocation?.used ?? 0}/${allocation?.total ?? 0}%`" />
                  </a-col>
                </a-row>
                <a-alert v-if="group.approvals.length < 2" class="mt" type="info" show-icon
                  :message="`审批进度 ${group.approvals.length}/2：${group.approvals.join('、') || '待审批'}`"
                  description="成员、顺序或名额任一变更都会作废已有审批，需产品与研发重新双审批。" />
                <a-alert v-if="group.lastResult" class="mt" :type="group.lastResult.ok ? 'success' : 'warning'" show-icon
                  :message="group.lastResult.ok ? '发布完成' : '发布未完成'" :description="group.lastResult.detail" />

                <!-- 成员表 -->
                <a-table :data-source="allocation?.rows ?? []" :pagination="false" size="small" row-key="member.seq" class="mt">
                  <a-table-column title="编号" :width="170">
                    <template #default="{ record }">
                      <a-space>
                        <a-tag :color="record.admitted ? 'green' : 'orange'">#{{ record.member.seq }}</a-tag>
                        <a-button size="small" type="text" :disabled="record.member.seq === 1 || group.status === 'releasing'"
                          @click="store.moveMember(record.member.seq, -1)">↑</a-button>
                        <a-button size="small" type="text"
                          :disabled="record.member.seq === group.members.length || group.status === 'releasing'"
                          @click="store.moveMember(record.member.seq, 1)">↓</a-button>
                      </a-space>
                    </template>
                  </a-table-column>
                  <a-table-column title="成员开关">
                    <template #default="{ record }">
                      <a-space direction="vertical" :size="2">
                        <a @click="record.flag && store.select(record.flag.id)">{{ record.flag?.name ?? '（开关已删除）' }}</a>
                        <span><code>{{ record.flag?.key ?? '—' }}</code></span>
                        <a-tag v-if="record.flag?.dependsOn.length" color="geekblue">
                          依赖 {{ record.flag.dependsOn.map((d: string) => flagOf(d)?.key).filter(Boolean).join('、') }}
                        </a-tag>
                      </a-space>
                    </template>
                  </a-table-column>
                  <a-table-column title="申请名额" :width="130">
                    <template #default="{ record }">
                      <a-input-number :value="record.member.want" :min="0" :max="100" :step="5"
                        :disabled="group.status === 'releasing'"
                        @change="(v: number) => store.setMemberWant(record.member.seq, v ?? 0)" addon-after="%" />
                    </template>
                  </a-table-column>
                  <a-table-column title="分配结果">
                    <template #default="{ record }">
                      <a-space direction="vertical" :size="2">
                        <a-tag :color="memberState(record).color">{{ memberState(record).text }}</a-tag>
                        <template v-if="!record.admitted">
                          <span class="blocker-hint">
                            还需 {{ record.member.want }}%，剩余仅 {{ (allocation?.total ?? 0) - (allocation?.used ?? 0) }}%；
                            名额被以下占位者占用：
                          </span>
                          <span>
                            <a-tag v-for="b in record.blockers" :key="b.seq" color="orange" class="mt4">
                              #{{ b.seq }} {{ b.key }} 占 {{ b.granted }}%
                            </a-tag>
                          </span>
                        </template>
                      </a-space>
                    </template>
                  </a-table-column>
                  <a-table-column title="故障注入" :width="150">
                    <template #default="{ record }">
                      <a-tooltip title="打开后该成员写入配置中心会失败，用于演示事务回滚与原编号重试">
                        <a-switch :checked="record.member.failWrite" checked-children="写入失败"
                          :disabled="group.status === 'releasing'"
                          @change="() => store.toggleMemberFault(record.member.seq)" />
                      </a-tooltip>
                    </template>
                  </a-table-column>
                  <a-table-column title="" :width="60">
                    <template #default="{ record }">
                      <a-button size="small" type="text" danger :disabled="group.status === 'releasing'"
                        @click="store.removeMember(record.member.seq)">删</a-button>
                    </template>
                  </a-table-column>
                </a-table>

                <!-- 添加成员 -->
                <div class="add-line">
                  <a-select v-model:value="addFlagId" style="width: 300px" placeholder="选择要加入组的开关"
                    :options="store.flags.filter((f) => !group?.members.some((m) => m.flagId === f.id))
                      .map((f) => ({ value: f.id, label: `${f.name}（${f.key}）` }))"
                    :disabled="group?.status === 'releasing'" allow-clear />
                  <a-input-number v-model:value="addWant" :min="0" :max="100" :step="5" addon-after="%" style="width:120px"
                    :disabled="group?.status === 'releasing'" />
                  <a-button type="dashed" :disabled="!addFlagId || group?.status === 'releasing'" @click="addMember">
                    追加到队尾（自动编号 #{{ group.members.length + 1 }}）
                  </a-button>
                </div>
                <a-alert v-if="waitingRows.length" class="mt" type="warning" show-icon
                  :message="`${waitingRows.length} 名成员留在待放行（编号保留，不插队）`">
                  <template #description>
                    <div v-for="row in waitingRows" :key="row.member.seq" class="wait-line">
                      <a-tag color="orange">#{{ row.member.seq }}</a-tag>
                      <code>{{ row.flag?.key }}</code> 申请 {{ row.member.want }}%，组内仅剩
                      {{ (allocation?.total ?? 0) - (allocation?.used ?? 0) }}%；占位者：
                      <a-tag v-for="b in row.blockers" :key="b.seq" color="orange">#{{ b.seq }} {{ b.key }}（{{ b.granted }}%）</a-tag>
                    </div>
                  </template>
                </a-alert>
              </a-card>
            </template>

            <!-- 开关详情 -->
            <a-card v-if="active" size="small" class="mb" :title="active.name">
              <template #extra>
                <a-space>
                  <a-tag :color="tagOf(active.status).color">{{ tagOf(active.status).label }}</a-tag>
                  <a-button v-if="active.status === 'invalidated'" size="small" @click="store.recoverFlag(active)">恢复为草稿</a-button>
                  <a-button type="primary" ghost size="small" :disabled="active.enabled" @click="store.enableAlone()">单独启用</a-button>
                  <a-button danger size="small" :disabled="!active.enabled" @click="store.emergencyStop">紧急停用</a-button>
                  <a-button danger ghost size="small" @click="store.rollback">回滚</a-button>
                </a-space>
              </template>
              <a-alert v-if="active.status === 'invalidated'" class="mb" type="error" show-icon
                :message="`已被联动失效：上游 ${active.invalidReason?.sourceKey} 发生「${active.invalidReason?.event}」`"
                description="所有依赖它的成员与所在发布组审批已一并作废，恢复上游后需重新审批。" />
              <a-form layout="vertical">
                <a-row :gutter="16">
                  <a-col :span="8">
                    <a-form-item label="目标地区">
                      <a-select :value="active.rules.region" :disabled="group?.status === 'releasing'"
                        :options="['全部', '上海', '北京', '广东'].map((v) => ({ value: v, label: v }))"
                        @change="(v: string) => store.updateRule({ region: v })" />
                    </a-form-item>
                  </a-col>
                  <a-col :span="8">
                    <a-form-item label="客户端版本">
                      <a-input :value="active.rules.appVersion"
                        @change="(e: Event) => store.updateRule({ appVersion: (e.target as HTMLInputElement).value })" />
                    </a-form-item>
                  </a-col>
                  <a-col :span="8">
                    <a-form-item label="登录要求">
                      <a-switch :checked="active.rules.authenticated"
                        @change="(v: boolean) => store.updateRule({ authenticated: v })" />
                    </a-form-item>
                  </a-col>
                </a-row>
                <a-form-item label="上游依赖（停用 / 回滚 / 改规则会立即联动失效本开关及其下游，并作废相关发布组审批）">
                  <a-select mode="multiple" :value="active.dependsOn" :options="depOptions" style="width: 100%"
                    placeholder="无上游依赖" @change="onDepChange" />
                </a-form-item>
              </a-form>
              <div class="quota-line">
                单独放量
                <a-slider :value="active.rollout" :min="0" :max="100" :step="5" style="width:260px;margin:0 10px"
                  @change="(v: number) => store.setRollout(v)" />
                <b>{{ active.rollout }}%</b>
              </div>
            </a-card>

            <!-- 审计 -->
            <a-card size="small" title="审计记录（发布失败的重试按幂等键合并，不重复记账）">
              <a-timeline>
                <a-timeline-item v-for="item in store.audit" :key="item.id"
                  :color="item.action.includes('失效') || item.action.includes('停止') || item.action.includes('回滚') || item.action.includes('失败') || item.action.includes('作废') || item.action.includes('中止') ? 'red'
                    : item.action.includes('成功') || item.action.includes('审批') ? 'green' : 'blue'">
                  <b>{{ item.at }} · {{ item.actor }}</b>
                  <p>{{ item.action }}：{{ item.detail }}
                    <a-tag v-if="item.idemKey" color="purple" class="mt4">幂等键 {{ item.idemKey }}</a-tag>
                  </p>
                </a-timeline-item>
              </a-timeline>
            </a-card>
          </a-col>
        </a-row>
      </a-layout-content>
    </a-layout>

    <!-- 新建开关 -->
    <a-modal v-model:open="flagOpen" title="新建功能开关" @ok="submitFlag">
      <a-form layout="vertical">
        <a-form-item label="展示名称" :validate-status="flagErrors.name ? 'error' : ''" :help="flagErrors.name">
          <a-input v-model:value="flagName" placeholder="如：新版结算页" />
        </a-form-item>
        <a-form-item label="开关 Key" :validate-status="flagErrors.key ? 'error' : ''" :help="flagErrors.key">
          <a-input v-model:value="flagKey" placeholder="小写字母、数字、连字符" />
        </a-form-item>
        <a-form-item label="上游依赖（可选，之后也能改）">
          <a-select v-model:value="newDeps" mode="multiple" allow-clear placeholder="选择必须先生效的上游开关"
            :options="store.flags.map((f) => ({ value: f.id, label: `${f.name}（${f.key}）` }))" />
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- 新建发布组 -->
    <a-modal v-model:open="groupOpen" title="新建联动发布组" @ok="submitGroup">
      <a-form layout="vertical">
        <a-form-item label="组名称"><a-input v-model:value="groupForm.name" placeholder="如：结算链路联动发布" /></a-form-item>
        <a-form-item label="组总名额（成员按编号顺序依次占用）">
          <a-slider v-model:value="groupForm.quota" :min="0" :max="100" :step="5" />
          <div class="rollout-label">总名额 {{ groupForm.quota }}%</div>
        </a-form-item>
      </a-form>
    </a-modal>
  </a-config-provider>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; background: #f4f6fb; font-family: Inter, "PingFang SC", sans-serif; }
.app-shell { min-height: 100vh; background: transparent; }
.topbar { height: auto; min-height: 88px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px 32px; color: white; background: linear-gradient(120deg, #111827, #312e81); }
.topbar h1 { color: white; margin: 3px 0; font-size: 25px; }
.eyebrow { color: #a5b4fc; font-size: 11px; letter-spacing: .13em; }
.content { max-width: 1500px; width: 100%; margin: 0 auto; padding: 24px; }
.mb { margin-bottom: 18px; }
.mt { margin-top: 12px; }
.mt4 { margin-top: 4px; }
.selected { background: #eef2ff; cursor: pointer; }
.ant-list-item { cursor: pointer; }
.rollout-label { color: #4338ca; font-weight: 700; }
.quota-line { display: flex; align-items: center; white-space: nowrap; }
.dep-box { display: flex; flex-direction: column; gap: 6px; }
.dep-col { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.dep-hint { color: #6b7280; font-size: 12px; margin-right: 6px; }
.dep-tag { margin: 0; }
.dep-arrow { color: #9ca3af; text-align: center; }
.dep-self { text-align: center; padding: 4px 0; }
.blocker-hint { color: #b45309; font-size: 12px; }
.wait-line { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: 4px; }
.add-line { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; align-items: center; }
@media (max-width: 720px) {
  .topbar { padding: 18px; flex-direction: column; align-items: flex-start; }
  .content { padding: 16px; }
}
</style>
