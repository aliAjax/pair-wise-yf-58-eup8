import { defineStore } from 'pinia';

export type FlagStatus = 'draft' | 'approved' | 'rolling' | 'scheduled' | 'stopped' | 'rolled-back' | 'invalid';
export interface RuleSet { region: string; appVersion: string; authenticated: boolean; }
export interface FeatureFlag { id: string; name: string; key: string; enabled: boolean; rollout: number; rules: RuleSet; status: FlagStatus; }
export interface RolloutPlan { id: string; flagId: string; scheduledAt: string; approvals: string[]; version: number; }
export interface AuditRecord { id: string; at: string; actor: string; action: string; detail: string; dedupKey?: string; }

/** 依赖关系：fromId（下游）依赖 toId（上游），上游停用/回滚/改规则会联动失效 */
export interface Dependency { id: string; fromId: string; toId: string; }

/** 成员在联动组内的状态：pending 待放行 / allocated 已占位 / started 已启动 / active 已生效 / failed 写入失败 / invalid 已失效 */
export type MemberStatus = 'pending' | 'allocated' | 'started' | 'active' | 'failed' | 'invalid';
export interface GroupMember {
  id: string;
  flagId: string;
  order: number;
  requestQuota: number;
  allocated: number;
  status: MemberStatus;
  forceFail: boolean;
  /** 启动前快照，写入失败后用于恢复到启动前状态 */
  preStart?: { enabled: boolean; rollout: number; status: FlagStatus };
}
export type GroupStatus = 'draft' | 'approved' | 'releasing' | 'active' | 'failed' | 'voided';
export interface ReleaseGroup {
  id: string;
  code: string;
  name: string;
  totalQuota: number;
  members: GroupMember[];
  approvals: string[];
  status: GroupStatus;
  version: number;
}

interface State {
  flags: FeatureFlag[];
  plans: RolloutPlan[];
  dependencies: Dependency[];
  groups: ReleaseGroup[];
  auditLogs: AuditRecord[];
  activeId: string;
  activeGroupId: string;
  groupSeq: number;
}

const seed: State = {
  activeId: 'f1',
  activeGroupId: 'g1',
  groupSeq: 1,
  flags: [
    { id: 'f1', name: '新版结算页', key: 'checkout-v2', enabled: true, rollout: 10, rules: { region: '上海', appVersion: '>= 8.2', authenticated: true }, status: 'rolling' },
    { id: 'f2', name: '推荐模型 B', key: 'recommend-model-b', enabled: false, rollout: 35, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, status: 'draft' }
  ],
  plans: [{ id: 'p1', flagId: 'f1', scheduledAt: '2026-10-01T10:00', approvals: [], version: 3 }],
  dependencies: [{ id: 'd1', fromId: 'f2', toId: 'f1' }],
  groups: [
    {
      id: 'g1', code: 'G-001', name: '首页改版联动组', totalQuota: 60, approvals: [], status: 'draft', version: 1,
      members: [
        { id: 'gm1', flagId: 'f1', order: 1, requestQuota: 30, allocated: 30, status: 'allocated', forceFail: false },
        { id: 'gm2', flagId: 'f2', order: 2, requestQuota: 50, allocated: 0, status: 'pending', forceFail: false }
      ]
    }
  ],
  auditLogs: [
    { id: 'a1', at: '09:10', actor: '产品负责人', action: '创建草稿', detail: 'checkout-v2 规则草案 v3' },
    { id: 'a2', at: '09:22', actor: '研发负责人', action: '规则校验', detail: '依赖 payment-v3 已启用' }
  ]
};

function load(): State { const saved = localStorage.getItem('yf58-flag-state-v2'); return saved ? JSON.parse(saved) as State : structuredClone(seed); }

/** 传递性下游：依赖 startId 的所有开关（沿 fromId→toId 的反方向传播） */
function transitiveDownstream(deps: Dependency[], startId: string): Set<string> {
  const result = new Set<string>();
  const queue = [startId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const d of deps) {
      if (d.toId === cur && !result.has(d.fromId)) { result.add(d.fromId); queue.push(d.fromId); }
    }
  }
  return result;
}

/** 新增 fromId→toId 是否会形成环（已有 toId→…→fromId 路径） */
function createsCycle(deps: Dependency[], fromId: string, toId: string): boolean {
  const seen = new Set<string>();
  const queue = [toId];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === fromId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const d of deps) if (d.fromId === cur) queue.push(d.toId);
  }
  return false;
}

export const useFlagStore = defineStore('flags', {
  state: () => load(),
  getters: {
    active(state): FeatureFlag | undefined { return state.flags.find((item) => item.id === state.activeId); },
    activePlan(state): RolloutPlan | undefined { return state.plans.find((item) => item.flagId === state.activeId); },
    activeGroup(state): ReleaseGroup | undefined { return state.groups.find((item) => item.id === state.activeGroupId); },
    flagName(state): (id: string) => string { return (id: string) => state.flags.find((f) => f.id === id)?.name ?? id; },
    upstreamOf(state): (id: string) => FeatureFlag[] {
      return (id: string) => state.dependencies.filter((d) => d.fromId === id).map((d) => state.flags.find((f) => f.id === d.toId)!).filter(Boolean);
    },
    downstreamOf(state): (id: string) => FeatureFlag[] {
      return (id: string) => state.dependencies.filter((d) => d.toId === id).map((d) => state.flags.find((f) => f.id === d.fromId)!).filter(Boolean);
    }
  },
  actions: {
    persist() { localStorage.setItem('yf58-flag-state-v2', JSON.stringify(this.$state)); },

    /** 审计记录：带 dedupKey 的动作幂等，重试不会重复记审计 */
    audit(action: string, detail: string, actor = '当前操作人', dedupKey?: string) {
      if (dedupKey && this.auditLogs.some((r) => r.dedupKey === dedupKey)) return;
      this.auditLogs.unshift({ id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: new Date().toLocaleTimeString(), actor, action, detail, dedupKey });
      this.persist();
    },

    select(id: string) { this.activeId = id; this.persist(); },
    selectGroup(id: string) { this.activeGroupId = id; this.persist(); },

    // ---------- 开关规则 ----------
    updateRule(rule: Partial<RuleSet>) {
      if (!this.active) return;
      this.active.rules = { ...this.active.rules, ...rule };
      this.active.status = 'draft';
      this.activePlan && (this.activePlan.approvals = []);
      this.audit('修改规则', JSON.stringify(this.active.rules));
      this.propagateChange(this.active.id, '规则改动');
    },
    setRollout(value: number) { if (!this.active) return; this.active.rollout = value; this.audit('调整放量', `${this.active.key} → ${value}%`); },
    schedule(value: string) { if (!this.active || !this.activePlan) return; this.activePlan.scheduledAt = value; this.active.status = 'scheduled'; this.audit('设置定时', `${this.active.key} 于 ${value} 生效`); },
    approve(role: string) {
      if (!this.active || !this.activePlan || this.activePlan.approvals.includes(role)) return;
      this.activePlan.approvals.push(role);
      this.active.status = this.activePlan.approvals.length >= 2 ? 'approved' : 'draft';
      this.audit('审批发布', `${role} 已确认 ${this.active.key}`, role);
      this.persist();
    },
    startRollout() {
      if (!this.active || this.active.status !== 'approved') return;
      this.active.enabled = true;
      this.active.status = 'rolling';
      this.audit('开始放量', `${this.active.key} 启用 ${this.active.rollout}%`);
      // 上游恢复放量后，自动解除下游开关的失效状态（联动组仍需重新审批）
      const downstream = transitiveDownstream(this.dependencies, this.active.id);
      for (const f of this.flags) {
        if (downstream.has(f.id) && f.status === 'invalid') { f.status = 'draft'; f.enabled = false; }
      }
      for (const g of this.groups) {
        for (const m of g.members) {
          if ((m.flagId === this.active.id || downstream.has(m.flagId)) && m.status === 'invalid') m.status = 'allocated';
        }
        this.allocate(g.id);
      }
      this.persist();
    },
    emergencyStop() {
      if (!this.active) return;
      this.active.enabled = false;
      this.active.status = 'stopped';
      this.audit('紧急停止', `${this.active.key} 已立即关闭`);
      this.propagateChange(this.active.id, '紧急停止');
    },
    rollback() {
      if (!this.active) return;
      this.active.enabled = false;
      this.active.rollout = 0;
      this.active.status = 'rolled-back';
      this.audit('执行回滚', `${this.active.key} 回滚至关闭状态`);
      this.propagateChange(this.active.id, '回滚');
    },

    /** 重新校验失效开关：所有上游依赖均已启用放量才解除失效 */
    revalidateFlag(flagId: string) {
      const flag = this.flags.find((f) => f.id === flagId);
      if (!flag || flag.status !== 'invalid') return;
      const ups = this.dependencies.filter((d) => d.fromId === flagId).map((d) => this.flags.find((f) => f.id === d.toId)!);
      const healthy = ups.length > 0 && ups.every((f) => f && f.enabled && f.status === 'rolling');
      if (ups.length === 0 || healthy) {
        flag.status = 'draft';
        flag.enabled = false;
        for (const g of this.groups) {
          for (const m of g.members) if (m.flagId === flagId && m.status === 'invalid') m.status = 'allocated';
          this.allocate(g.id);
        }
        this.audit('重新校验', `${flag.key} 上游依赖已恢复，联动失效解除`);
        this.persist();
      }
    },

    /**
     * 联动传播：上游开关停用 / 回滚 / 规则改动后，
     * 依赖它的下游开关立即失效，包含失效成员的联动组整组审批作废。
     */
    propagateChange(flagId: string, reason: string) {
      const downstream = transitiveDownstream(this.dependencies, flagId);
      for (const f of this.flags) {
        if (downstream.has(f.id) && f.status !== 'invalid') {
          f.enabled = false;
          f.status = 'invalid';
          this.audit('联动失效', `${f.key} 因上游${reason}立即失效`, '当前操作人', `propagate:${f.id}:${flagId}`);
        }
      }
      for (const g of this.groups) {
        let voided = false;
        for (const m of g.members) {
          const f = this.flags.find((x) => x.id === m.flagId);
          if (!f) continue;
          if (downstream.has(m.flagId) && m.status !== 'invalid') { m.status = 'invalid'; m.allocated = 0; voided = true; }
          if (['stopped', 'rolled-back', 'invalid'].includes(f.status)) {
            voided = true;
            if (m.status !== 'invalid') { m.status = 'invalid'; m.allocated = 0; }
          }
        }
        if (voided && g.status !== 'voided') {
          g.approvals = [];
          g.status = 'voided';
          this.audit('整组作废', `联动组 ${g.code} 因上游${reason}，整组审批已作废`, '当前操作人', `void:${g.id}:${flagId}`);
        }
      }
      this.persist();
    },

    // ---------- 依赖关系 ----------
    addDependency(fromId: string, toId: string) {
      if (fromId === toId) return;
      if (this.dependencies.some((d) => d.fromId === fromId && d.toId === toId)) return;
      if (createsCycle(this.dependencies, fromId, toId)) return;
      this.dependencies.push({ id: `d-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, fromId, toId });
      const from = this.flags.find((f) => f.id === fromId);
      const to = this.flags.find((f) => f.id === toId);
      this.audit('新增依赖', `${from?.name ?? fromId} → ${to?.name ?? toId}`);
      // 新增依赖时上游本就不可用，下游立即失效
      if (to && (!to.enabled || to.status !== 'rolling')) this.propagateChange(toId, '新增依赖');
      this.persist();
    },
    removeDependency(id: string) {
      const dep = this.dependencies.find((d) => d.id === id);
      this.dependencies = this.dependencies.filter((d) => d.id !== id);
      if (dep) this.audit('移除依赖', `${this.flags.find((f) => f.id === dep.fromId)?.name} 不再依赖 ${this.flags.find((f) => f.id === dep.toId)?.name}`);
      this.persist();
    },

    // ---------- 联动发布组 ----------
    createGroup(name: string, totalQuota: number) {
      const id = `g-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const code = `G-${String(this.groupSeq).padStart(3, '0')}`;
      this.groupSeq += 1;
      this.groups.push({ id, code, name, totalQuota, approvals: [], status: 'draft', version: 1, members: [] });
      this.activeGroupId = id;
      this.audit('创建联动组', `编号 ${code} 总名额 ${totalQuota}`, '当前操作人', `group:create:${id}`);
      this.persist();
    },
    addMember(groupId: string, flagId: string, requestQuota: number) {
      const g = this.groups.find((x) => x.id === groupId);
      if (!g || g.members.some((m) => m.flagId === flagId)) return;
      const order = g.members.length + 1;
      g.members.push({ id: `gm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, flagId, order, requestQuota, allocated: 0, status: 'pending', forceFail: false });
      this.allocate(groupId);
      this.audit('加入成员', `${g.code} 新增 ${this.flags.find((f) => f.id === flagId)?.name}，申请名额 ${requestQuota}`);
    },
    removeMember(groupId: string, memberId: string) {
      const g = this.groups.find((x) => x.id === groupId);
      if (!g) return;
      g.members = g.members.filter((m) => m.id !== memberId).map((m, i) => ({ ...m, order: i + 1 }));
      this.allocate(groupId);
    },
    moveMember(groupId: string, memberId: string, dir: -1 | 1) {
      const g = this.groups.find((x) => x.id === groupId);
      if (!g) return;
      const sorted = [...g.members].sort((a, b) => a.order - b.order);
      const idx = sorted.findIndex((m) => m.id === memberId);
      const swap = idx + dir;
      if (swap < 0 || swap >= sorted.length) return;
      const a = sorted[idx];
      const b = sorted[swap];
      const o = a.order; a.order = b.order; b.order = o;
      this.allocate(groupId);
    },
    setRequestQuota(groupId: string, memberId: string, quota: number) {
      const g = this.groups.find((x) => x.id === groupId);
      if (!g) return;
      const m = g.members.find((x) => x.id === memberId);
      if (!m) return;
      m.requestQuota = quota;
      this.allocate(groupId);
    },
    setTotalQuota(groupId: string, quota: number) {
      const g = this.groups.find((x) => x.id === groupId);
      if (!g) return;
      g.totalQuota = quota;
      this.allocate(groupId);
    },
    toggleForceFail(groupId: string, memberId: string) {
      const g = this.groups.find((x) => x.id === groupId);
      if (!g) return;
      const m = g.members.find((x) => x.id === memberId);
      if (m) m.forceFail = !m.forceFail;
      this.persist();
    },

    /**
     * 按顺序分配总名额：占位者占满后，超额成员留在待放行并列出占位者。
     * 仅在草稿 / 作废 / 失败状态可调整，发布中 / 已生效不允许改额。
     */
    allocate(groupId: string) {
      const g = this.groups.find((x) => x.id === groupId);
      if (!g) return;
      if (!['draft', 'voided', 'failed'].includes(g.status)) return;
      let remaining = g.totalQuota;
      for (const m of [...g.members].sort((a, b) => a.order - b.order)) {
        if (m.status === 'invalid') { m.allocated = 0; continue; }
        if (m.requestQuota <= remaining) {
          m.allocated = m.requestQuota;
          remaining -= m.requestQuota;
          m.status = 'allocated';
        } else {
          m.allocated = 0;
          m.status = 'pending';
        }
      }
      this.persist();
    },

    approveGroup(groupId: string, role: string) {
      const g = this.groups.find((x) => x.id === groupId);
      if (!g || g.approvals.includes(role)) return;
      g.approvals.push(role);
      g.status = g.approvals.length >= 2 ? 'approved' : 'draft';
      this.audit('联动组审批', `${role} 已确认 ${g.code}`, role, `group:approve:${g.id}:${role}`);
      this.persist();
    },

    /** 模拟远端写入成员；forceFail 用于演示写入失败 */
    simulateWrite(member: GroupMember): Promise<boolean> {
      return new Promise((resolve) => setTimeout(() => resolve(!member.forceFail), 450));
    },

    /**
     * 按顺序写入成员（事务）：
     * - 写入失败：已启动成员恢复到启动前状态，组置为 failed；
     * - 未完成组按原编号重试，审计按 dedupKey 幂等，不重复记录。
     */
    async startGroup(groupId: string) {
      const g = this.groups.find((x) => x.id === groupId);
      if (!g) return;
      if (!['approved', 'failed'].includes(g.status)) return;
      g.status = 'releasing';
      this.audit('开始联动发布', `编号 ${g.code} 共 ${g.members.length} 个成员`, '当前操作人', `group:start:${g.id}`);

      // 补偿：已启动（含已写入成功）的成员一律恢复到启动前状态
      const rollbackStarted = (reason: string) => {
        for (const prev of [...g.members].sort((a, b) => a.order - b.order)) {
          if (!['started', 'active'].includes(prev.status)) continue;
          const pf = this.flags.find((x) => x.id === prev.flagId);
          if (pf && prev.preStart) {
            pf.enabled = prev.preStart.enabled;
            pf.rollout = prev.preStart.rollout;
            pf.status = prev.preStart.status;
          }
          prev.status = 'allocated';
          this.audit('补偿回滚', `${g.code} 已恢复 ${pf?.name ?? prev.flagId} 到启动前状态（${reason}）`, '当前操作人', `group:rollback:${g.id}:${prev.id}`);
        }
      };

      for (const m of [...g.members].sort((a, b) => a.order - b.order)) {
        if (m.status === 'active') continue;
        if (m.status === 'invalid') {
          rollbackStarted('上游失效');
          g.status = 'voided';
          this.audit('整组作废', `${g.code} 存在已失效成员，发布终止`, '当前操作人', `group:invalid:${g.id}`);
          this.persist();
          return;
        }
        if (m.allocated === 0) continue; // 待放行成员不写入

        const f = this.flags.find((x) => x.id === m.flagId)!;
        m.preStart = { enabled: f.enabled, rollout: f.rollout, status: f.status };
        m.status = 'started';
        this.audit('成员写入', `${g.code} ${f.name} 占用 ${m.allocated}% 名额`, '当前操作人', `group:write:${g.id}:${m.id}`);

        const ok = await this.simulateWrite(m);
        if (!ok) {
          m.status = 'failed';
          this.audit('成员写入失败', `${g.code} ${f.name} 写入失败，开始回滚已启动成员`, '当前操作人', `group:fail:${g.id}:${m.id}`);
          rollbackStarted('写入失败');
          g.status = 'failed';
          this.audit('发布失败', `${g.code} 未完成，可按原编号重试`, '当前操作人', `group:failed:${g.id}`);
          this.persist();
          return;
        }

        m.status = 'active';
        f.enabled = true;
        f.rollout = m.allocated;
        f.status = 'rolling';
        this.audit('成员生效', `${g.code} ${f.name} 已生效`, '当前操作人', `group:active:${g.id}:${m.id}`);
      }

      g.status = 'active';
      this.audit('联动发布完成', `编号 ${g.code} 全部占位成员已生效`, '当前操作人', `group:done:${g.id}`);
      this.persist();
    },

    simulateHit(user: { region: string; appVersion: string; authenticated: boolean; id: string }) {
      if (!this.active || !this.active.enabled) return { hit: false, reason: '开关未启用' };
      const rule = this.active.rules;
      if (rule.region !== '全部' && rule.region !== user.region) return { hit: false, reason: `地区不匹配（要求${rule.region}）` };
      if (rule.authenticated && !user.authenticated) return { hit: false, reason: '要求已登录用户' };
      const hash = [...user.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 100;
      const hit = hash < this.active.rollout;
      return { hit, reason: hit ? `灰度桶 ${hash} < ${this.active.rollout}%` : `灰度桶 ${hash} ≥ ${this.active.rollout}%` };
    }
  }
});
