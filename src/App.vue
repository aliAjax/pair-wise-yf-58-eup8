<script setup lang="ts">
import { ref } from 'vue';
import { useOnline } from '@vueuse/core';
import FlagConsole from './components/FlagConsole.vue';
import GroupConsole from './components/GroupConsole.vue';
import DependencyConsole from './components/DependencyConsole.vue';
import AuditTimeline from './components/AuditTimeline.vue';

const online = useOnline();
const tab = ref('flags');
</script>

<template>
  <a-config-provider>
    <a-layout class="app-shell">
      <a-layout-header class="topbar">
        <div>
          <div class="eyebrow">FEATURE FLAG / RELEASE GROUPS / PORT 62023</div>
          <h1>功能开关与联动发布控制台</h1>
        </div>
        <a-space><a-tag :color="online ? 'green' : 'orange'">{{ online ? '控制面在线' : '离线草稿' }}</a-tag></a-space>
      </a-layout-header>
      <a-layout-content class="content">
        <a-alert v-if="!online" type="warning" show-icon message="离线状态" description="规则修改保留在浏览器，恢复网络后仍需完成审批才能发布。" class="mb" />
        <a-tabs v-model:activeKey="tab">
          <a-tab-pane key="flags" tab="功能开关"><FlagConsole /></a-tab-pane>
          <a-tab-pane key="groups" tab="联动发布组"><GroupConsole /></a-tab-pane>
          <a-tab-pane key="deps" tab="依赖关系"><DependencyConsole /></a-tab-pane>
          <a-tab-pane key="audit" tab="审计记录"><AuditTimeline /></a-tab-pane>
        </a-tabs>
      </a-layout-content>
    </a-layout>
  </a-config-provider>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; background: #f4f6fb; font-family: Inter, "PingFang SC", sans-serif; }
.app-shell { min-height: 100vh; background: transparent; }
.topbar { height: auto; min-height: 88px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px 32px; color: white; background: linear-gradient(120deg, #111827, #312e81); }
.topbar h1 { color: white; margin: 3px 0; font-size: 25px; }
.eyebrow { color: #a5b4fc; font-size: 11px; letter-spacing: .13em; }
.content { max-width: 1400px; width: 100%; margin: 0 auto; padding: 24px; }
.mb { margin-bottom: 18px; }
.ant-list-item { cursor: pointer; }
@media (max-width: 720px) { .topbar { padding: 18px; flex-direction: column; align-items: flex-start; } .content { padding: 16px; } }
</style>
