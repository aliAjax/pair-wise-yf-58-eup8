import { defineStore } from 'pinia';

export type FlagStatus = 'draft' | 'approved' | 'rolling' | 'scheduled' | 'stopped' | 'rolled-back' | 'invalidated';
export type GroupStatus = 'draft' | 'approved' | 'releasing' | 'released' | 'partial' | 'invalidated';

export interface RuleSet { region: string; appVersion: string; authenticated: boolean; }

export interface FeatureFlag {
  id: string;
  name: string;
  key: string;
  enabled: boolean;
  rollout: number;
  rules: RuleSet;
  status: FlagStatus;
  /** 直接依赖的上游开关 id */
  dependsOn: string[];
  /** 联动失效信息：被哪个上游的什么事件带累 */
  invalidReason?: { sourceKey: string; event: string };
}

export interface GroupMember {
  /** 组内编号，分配和发布都严格按此顺序 */
  seq: number;
  flagId: string;
  /** 本次想要的名额（放量百分点） */
  want: number;
  /** 模拟写入开关，打开后该成员的写入会失败，用于演示事务回滚 */
  failWrite: boolean;
}

export interface ReleaseGroup {
  id: string;
  name: string;
  /** 组总名额（放量百分点），成员按编号顺序依次占用 */
  totalQuota: number;
  members: GroupMember[];
  approvals: string[];
  status: GroupStatus;
  /** 发布会话编号：失败后按原编号重试沿用同一会话，成功后或结构变更才开新会话 */
  launchNo: number;
  /** 同一会话内每次尝试的结果，合并写入同一条审计（重试不重复记账） */
  sessionLog: string[];
  /** 最近一次发布结果 */
  lastResult?: { ok: boolean; detail: string };
}

export interface AuditRecord {
  id: string;
  /** 幂等键：同一组同一次发布（含重试）只保留一条审计 */
  idemKey?: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
}

interface State {
  flags: FeatureFlag[];
  groups: ReleaseGroup[];
  audit: AuditRecord[];
  activeId: string;
  activeGroupId: string;
}

export interface MemberAllocation {
  member: GroupMember;
  flag?: FeatureFlag;
  admitted: boolean;
  granted: number;
  /** 未放行时占用名额的成员（占位者） */
  blockers: { seq: number; key: string; name: string; granted: number }[];
}

export interface GroupAllocation {
  total: number;
  used: number;
  rows: MemberAllocation[];
}

/* ----------------------------- 纯函数领域逻辑 ----------------------------- */

/** 开关当前是否“有效”：已启用且没有被上游联动失效 */
export function isEffective(flag: FeatureFlag | undefined, all: FeatureFlag[]): boolean {
  if (!flag || !flag.enabled || flag.status === 'invalidated') return false;
  return flag.dependsOn.every((id) => {
    const up = all.find((f) => f.id === id);
    return up ? isEffective(up, all) : false;
  });
}

/** 计算某开关的全部下游（含传递） */
export function downstreamOf(flagId: string, flags: FeatureFlag[]): FeatureFlag[] {
  const result: FeatureFlag[] = [];
  const walk = (id: string) => {
    for (const f of flags) {
      if (f.dependsOn.includes(id) && !result.includes(f)) {
        result.push(f);
        walk(f.id);
      }
    }
  };
  walk(flagId);
  return result;
}

/** 依赖图中加入一条边是否会形成环 */
export function wouldCycle(flags: FeatureFlag[], targetId: string, newDepId: string): boolean {
  if (targetId === newDepId) return true;
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    const node = flags.find((f) => f.id === from);
    return node ? node.dependsOn.some((d) => reaches(d, to, seen)) : false;
  };
  // 新边 target -> newDep：若 newDep 已能（传递地）到达 target，则成环
  return reaches(newDepId, targetId);
}

/**
 * 组内顺序名额分配：严格按编号依次要名额，一旦某成员要不下剩余名额，
 * 它及其后所有成员都留在待放行（不能插队）。
 */
export function allocate(group: ReleaseGroup, flags: FeatureFlag[]): GroupAllocation {
  const ordered = [...group.members].sort((a, b) => a.seq - b.seq);
  const admittedRows: MemberAllocation[] = [];
  const waitingRows: MemberAllocation[] = [];
  let used = 0;
  let blocked = false;
  for (const member of ordered) {
    const flag = flags.find((f) => f.id === member.flagId);
    if (!blocked && used + member.want <= group.totalQuota) {
      used += member.want;
      admittedRows.push({ member, flag, admitted: true, granted: member.want, blockers: [] });
    } else {
      blocked = true;
      waitingRows.push({ member, flag, admitted: false, granted: 0, blockers: [] });
    }
  }
  const holders = admittedRows.map((r) => ({ seq: r.member.seq, key: r.flag?.key ?? '?', name: r.flag?.name ?? '已删除开关', granted: r.granted }));
  for (const row of waitingRows) {
    // 占不下自己的最后一个占位者 + 其余占位者都列出
    row.blockers = holders;
  }
  return { total: group.totalQuota, used, rows: [...admittedRows, ...waitingRows] };
}

/** 模拟远端成员写入（带 200ms 延迟），failWrite 或开关缺失即失败 */
export function writeMember(member: GroupMember, flags: FeatureFlag[]): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const flag = flags.find((f) => f.id === member.flagId);
      if (!flag) resolve({ ok: false, message: `#${member.seq} 开关已不存在，写入被拒绝` });
      else if (member.failWrite) resolve({ ok: false, message: `#${member.seq} ${flag.key} 配置中心写入超时（故障注入）` });
      else resolve({ ok: true, message: `#${member.seq} ${flag.key} 写入 ${member.want}%` });
    }, 200);
  });
}

/* --------------------------------- Store --------------------------------- */

const seed: State = {
  activeId: 'f2',
  activeGroupId: 'g1',
  flags: [
    { id: 'f1', name: '支付网关 v3', key: 'payment-v3', enabled: true, rollout: 100, rules: { region: '全部', appVersion: '>= 8.0', authenticated: true }, status: 'rolling', dependsOn: [] },
    { id: 'f2', name: '新版结算页', key: 'checkout-v2', enabled: false, rollout: 10, rules: { region: '上海', appVersion: '>= 8.2', authenticated: true }, status: 'draft', dependsOn: ['f1'] },
    { id: 'f3', name: '推荐模型 B', key: 'recommend-model-b', enabled: true, rollout: 35, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, status: 'rolling', dependsOn: [] },
    { id: 'f4', name: '智能搜索框', key: 'smart-search', enabled: false, rollout: 20, rules: { region: '北京', appVersion: '>= 8.1', authenticated: false }, status: 'draft', dependsOn: ['f3', 'f2'] },
    { id: 'f5', name: '结算页优惠券', key: 'checkout-coupon', enabled: false, rollout: 15, rules: { region: '上海', appVersion: '>= 8.2', authenticated: true }, status: 'draft', dependsOn: ['f2'] }
  ],
  groups: [
    {
      id: 'g1',
      name: '结算链路联动发布',
      totalQuota: 50,
      approvals: [],
      status: 'draft',
      launchNo: 0,
      sessionLog: [],
      members: [
        { seq: 1, flagId: 'f2', want: 20, failWrite: false },
        { seq: 2, flagId: 'f4', want: 20, failWrite: false },
        { seq: 3, flagId: 'f5', want: 20, failWrite: false }
      ]
    }
  ],
  audit: [
    { id: 'a1', at: '09:10', actor: '产品负责人', action: '创建开关', detail: 'checkout-v2 依赖 payment-v3' },
    { id: 'a2', at: '09:22', actor: '研发负责人', action: '创建发布组', detail: '结算链路联动发布，总名额 50%，成员 3 名' }
  ]
};

function load(): State {
  const saved = localStorage.getItem('yf58-flag-state');
  if (saved) {
    const parsed = JSON.parse(saved) as State;
    if (parsed.flags && parsed.groups) return parsed;
  }
  return structuredClone(seed);
}

let auditSeq = 100;

export const useFlagStore = defineStore('flags', {
  state: () => load(),
  getters: {
    active(state): FeatureFlag | undefined { return state.flags.find((item) => item.id === state.activeId); },
    activeGroup(state): ReleaseGroup | undefined { return state.groups.find((item) => item.id === state.activeGroupId); },
    effectiveFlags(state): FeatureFlag[] { return state.flags.filter((f) => isEffective(f, state.flags)); },
    allocationFor(state): (group: ReleaseGroup) => GroupAllocation {
      return (group: ReleaseGroup) => allocate(group, state.flags);
    }
  },
  actions: {
    persist() { localStorage.setItem('yf58-flag-state', JSON.stringify(this.$state)); },
    now() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); },

    /** 幂等写入审计：同一 idemKey 的记录只保留最新一条，重试不重复记账 */
    upsertAudit(idemKey: string | undefined, action: string, detail: string, actor = '当前操作人') {
      if (idemKey) {
        const existing = this.audit.find((a) => a.idemKey === idemKey);
        if (existing) { existing.at = this.now(); existing.actor = actor; existing.action = action; existing.detail = detail; this.persist(); return; }
      }
      this.audit.unshift({ id: `a-${Date.now()}-${auditSeq++}`, idemKey, at: this.now(), actor, action, detail });
      this.persist();
    },

    select(id: string) { this.activeId = id; this.persist(); },
    selectGroup(id: string) { this.activeGroupId = id; this.persist(); },

    /* ------------------------------ 开关管理 ------------------------------ */

    createFlag(name: string, key: string, dependsOn: string[]) {
      const id = `f-${Date.now()}`;
      this.flags.push({
        id, name, key, enabled: false, rollout: 0, dependsOn,
        rules: { region: '全部', appVersion: '>= 1.0', authenticated: false }, status: 'draft'
      });
      this.activeId = id;
      this.upsertAudit(undefined, '创建开关', `${key}${dependsOn.length ? `，依赖 ${dependsOn.map((d) => this.flags.find((f) => f.id === d)?.key).join('、')}` : ''}`);
    },

    updateRule(rule: Partial<RuleSet>) {
      const flag = this.active;
      if (!flag) return;
      flag.rules = { ...flag.rules, ...rule };
      flag.status = 'draft';
      this.upsertAudit(undefined, '修改规则', `${flag.key} 规则变更为 ${JSON.stringify(flag.rules)}`);
      // 规则改动属于上游变更：下游立即失效，相关组整组审批作废
      this.cascadeInvalidate(flag, '规则改动');
    },

    setDependencies(flag: FeatureFlag, deps: string[]) {
      for (const dep of deps) {
        if (wouldCycle(this.flags, flag.id, dep)) {
          this.upsertAudit(undefined, '依赖被拒绝', `${flag.key} → ${this.flags.find((f) => f.id === dep)?.key} 会形成依赖环`);
          return false;
        }
      }
      flag.dependsOn = deps;
      this.upsertAudit(undefined, '修改依赖', `${flag.key} 上游改为 ${deps.map((d) => this.flags.find((f) => f.id === d)?.key ?? '无').join('、') || '无'}`);
      this.persist();
      return true;
    },

    setRollout(value: number) {
      const flag = this.active;
      if (!flag) return;
      flag.rollout = value;
      this.upsertAudit(undefined, '调整放量', `${flag.key} → ${value}%`);
    },

    emergencyStop() {
      const flag = this.active;
      if (!flag) return;
      flag.enabled = false;
      flag.status = 'stopped';
      this.upsertAudit(undefined, '紧急停止', `${flag.key} 已立即关闭`);
      // 上游停用：下游马上失效，组审批整组作废
      this.cascadeInvalidate(flag, '上游停用');
    },

    rollback() {
      const flag = this.active;
      if (!flag) return;
      flag.enabled = false;
      flag.rollout = 0;
      flag.status = 'rolled-back';
      this.upsertAudit(undefined, '执行回滚', `${flag.key} 回滚至关闭状态`);
      // 回滚同样级联
      this.cascadeInvalidate(flag, '上游回滚');
    },

    /** 组外单独启用开关：上游必须全部有效 */
    enableAlone() {
      const flag = this.active;
      if (!flag) return;
      const broken = flag.dependsOn
        .map((id) => this.flags.find((f) => f.id === id))
        .filter((up): up is FeatureFlag => !up || !isEffective(up, this.flags));
      if (broken.length) {
        this.upsertAudit(undefined, '启用被阻止', `${flag.key} 的上游 ${broken.map((f) => f.key).join('、')} 未生效`);
        return false;
      }
      flag.enabled = true;
      flag.status = 'rolling';
      flag.invalidReason = undefined;
      this.upsertAudit(undefined, '启用开关', `${flag.key} 单独启用 ${flag.rollout}%`);
      return true;
    },

    /** 失效开关的恢复：清掉失效标记回到草稿，重新走审批 */
    recoverFlag(flag: FeatureFlag) {
      flag.status = 'draft';
      flag.enabled = false;
      flag.invalidReason = undefined;
      this.upsertAudit(undefined, '恢复开关', `${flag.key} 失效标记已清除，回到草稿待审批`);
    },

    /**
     * 级联失效：source 发生停用/回滚/规则改动后，
     * 其全部（含传递）依赖者立即失效；包含受影响成员的发布组整组审批作废。
     */
    cascadeInvalidate(source: FeatureFlag, event: string) {
      const victims = downstreamOf(source.id, this.flags);
      const affectedIds = new Set(victims.map((v) => v.id));
      affectedIds.add(source.id); // 源开关自身（停用/回滚/规则改动）也使所在组的审批前提失效
      for (const v of victims) {
        v.enabled = false;
        v.status = 'invalidated';
        v.invalidReason = { sourceKey: source.key, event };
      }
      if (victims.length) {
        this.upsertAudit(undefined, '联动失效', `${source.key}${event}，${victims.map((v) => v.key).join('、')} 立即失效`);
      }
      for (const group of this.groups) {
        const hit = group.members.some((m) => affectedIds.has(m.flagId));
        if (!hit) continue;
        // 有审批或已发布的组才需要“整组作废”；纯草稿组只需等待成员恢复
        if (group.approvals.length || group.status === 'released') {
          group.approvals = [];
          group.status = 'invalidated';
          this.upsertAudit(undefined, '组审批作废', `《${group.name}》因 ${source.key}${event} 整组审批作废，需重新审批`);
        }
      }
      this.persist();
    },

    /* ------------------------------ 发布组管理 ----------------------------- */

    createGroup(name: string, totalQuota: number) {
      const id = `g-${Date.now()}`;
      this.groups.push({ id, name, totalQuota, members: [], approvals: [], status: 'draft', launchNo: 0, sessionLog: [] });
      this.activeGroupId = id;
      this.upsertAudit(undefined, '创建发布组', `${name}，总名额 ${totalQuota}%`);
    },

    addMember(flagId: string, want: number) {
      const group = this.activeGroup;
      if (!group || !flagId) return;
      if (group.members.some((m) => m.flagId === flagId)) return;
      const seq = group.members.length ? Math.max(...group.members.map((m) => m.seq)) + 1 : 1;
      group.members.push({ seq, flagId, want, failWrite: false });
      this.invalidateGroupStructure('新增成员');
    },

    removeMember(seq: number) {
      const group = this.activeGroup;
      if (!group) return;
      group.members = group.members.filter((m) => m.seq !== seq).map((m, i) => ({ ...m, seq: i + 1 }));
      this.invalidateGroupStructure('移除成员');
    },

    moveMember(seq: number, delta: -1 | 1) {
      const group = this.activeGroup;
      if (!group) return;
      const ordered = [...group.members].sort((a, b) => a.seq - b.seq);
      const i = ordered.findIndex((m) => m.seq === seq);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= ordered.length) return;
      [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
      group.members = ordered.map((m, idx) => ({ ...m, seq: idx + 1 }));
      this.invalidateGroupStructure('调整成员顺序');
    },

    setMemberWant(seq: number, want: number) {
      const group = this.activeGroup;
      if (!group) return;
      const m = group.members.find((x) => x.seq === seq);
      if (m) { m.want = want; this.invalidateGroupStructure('调整成员名额'); }
    },

    toggleMemberFault(seq: number) {
      const group = this.activeGroup;
      if (!group) return;
      const m = group.members.find((x) => x.seq === seq);
      if (m) { m.failWrite = !m.failWrite; this.persist(); }
    },

    setGroupQuota(value: number) {
      const group = this.activeGroup;
      if (!group) return;
      group.totalQuota = value;
      this.invalidateGroupStructure('调整组总名额');
    },

    /** 结构变更（成员/顺序/名额）后，名额分配已变，已有审批一律作废 */
    invalidateGroupStructure(change: string) {
      const group = this.activeGroup;
      if (!group) return;
      if (group.status === 'releasing') return;
      if (group.approvals.length || group.status !== 'draft') {
        group.approvals = [];
        group.status = 'draft';
        group.lastResult = undefined;
        this.upsertAudit(undefined, '组结构变更', `《${group.name}》${change}，原审批作废需重新审批`);
      }
      this.persist();
    },

    approveGroup(role: string) {
      const group = this.activeGroup;
      if (!group || group.status === 'releasing') return;
      if (group.approvals.includes(role)) return;
      group.approvals.push(role);
      group.status = group.approvals.length >= 2 ? 'approved' : 'draft';
      this.upsertAudit(undefined, '组审批', `${role} 审批《${group.name}》（${group.approvals.length}/2）`, role);
    },

    /**
     * 组发布事务：按原编号顺序依次写入成员；任一失败 →
     * 已启动成员恢复到启动前状态，整组保留原编号等待重试。
     * 同一会话的首次发布与所有重试共用一条审计（幂等键 launch:<组>:<会话号>），
     * 每次尝试只追加到该条审计，绝不重复记账。
     */
    async launchGroup(): Promise<void> {
      const group = this.activeGroup;
      if (!group || group.status === 'releasing') return;
      if (group.approvals.length < 2) { group.lastResult = { ok: false, detail: '需要产品和研发双审批' }; this.persist(); return; }

      const alloc = allocate(group, this.flags);
      const admitted = alloc.rows.filter((r) => r.admitted).map((r) => r.member);
      if (!admitted.length) { group.lastResult = { ok: false, detail: '没有获得名额的成员' }; this.persist(); return; }

      // 放行前校验：成员自身或传递依赖的上游失效则整组拒绝（依赖联动）
      const stale = admitted
        .map((m) => this.flags.find((f) => f.id === m.flagId))
        .filter((f): f is FeatureFlag => !f || f.status === 'invalidated' || !f.dependsOn.every((d) => isEffective(this.flags.find((x) => x.id === d), this.flags)));
      if (stale.length) {
        group.approvals = [];
        group.status = 'invalidated';
        this.upsertAudit(undefined, '组发布中止', `《${group.name}》成员 ${stale.map((f) => f.key).join('、')} 的依赖已失效，审批作废`);
        return;
      }

      // partial = 上一轮写入失败，按原编号重试 → 沿用同一会话号与同一条审计
      const retrying = group.status === 'partial';
      if (!retrying) { group.launchNo += 1; group.sessionLog = []; }
      const no = group.launchNo;
      const idemKey = `launch:${group.id}:${no}`;
      const attemptNo = group.sessionLog.length + 1;
      group.status = 'releasing';
      this.persist();

      // 快照：启动前成员开关状态，失败时精确恢复
      const snapshot = admitted.map((m) => {
        const f = this.flags.find((x) => x.id === m.flagId)!;
        return { flag: f, enabled: f.enabled, rollout: f.rollout, status: f.status, invalidReason: f.invalidReason };
      });

      const done: typeof snapshot = [];
      const messages: string[] = [];
      try {
        for (const member of admitted) {
          const res = await writeMember(member, this.flags);
          messages.push(res.message);
          if (!res.ok) throw new Error(res.message);
          const f = this.flags.find((x) => x.id === member.flagId)!;
          f.enabled = true;
          f.rollout = member.want;
          f.status = 'rolling';
          f.invalidReason = undefined;
          done.push(snapshot.find((s) => s.flag.id === member.flagId)!);
        }
      } catch (err) {
        // 恢复已启动成员到启动前状态（未写入的成员本来就没动）
        for (const s of done) {
          s.flag.enabled = s.enabled;
          s.flag.rollout = s.rollout;
          s.flag.status = s.status;
          s.flag.invalidReason = s.invalidReason;
        }
        group.status = 'partial';
        group.sessionLog.push(`第${attemptNo}次尝试失败：${(err as Error).message}，已回滚 ${done.length} 个已启动开关`);
        group.lastResult = { ok: false, detail: `${(err as Error).message}；已启动的 ${done.length} 名成员已全部恢复到启动前状态，可按原编号立即重试` };
        // 同一幂等键：首次失败与后续重试始终维护同一条审计
        this.upsertAudit(idemKey, retrying ? '组发布重试未通过' : '组发布失败待重试',
          `《${group.name}》发布会话 #${no}（原编号重试中）：` + group.sessionLog.join('；'));
        return;
      }

      group.status = 'released';
      const waiting = alloc.rows.filter((r) => !r.admitted);
      group.sessionLog.push(`第${attemptNo}次尝试成功：${messages.join('；')}`);
      group.lastResult = {
        ok: true,
        detail: `按编号 ${admitted.map((m) => `#${m.seq}`).join('→')} 全部写入成功，占用 ${alloc.used}/${alloc.total}%` +
          (waiting.length ? `；#${waiting.map((r) => r.member.seq).join('、#')} 留在待放行` : '')
      };
      this.upsertAudit(idemKey, retrying ? '组发布重试成功' : '组发布成功',
        `《${group.name}》发布会话 #${no}：` + group.sessionLog.join('；') +
        (waiting.length ? `；待放行编号 #${waiting.map((r) => r.member.seq).join('、#')}` : ''));
    },

    /* ------------------------------ 命中模拟 ------------------------------ */

    simulateHit(user: { region: string; appVersion: string; authenticated: boolean; id: string }) {
      if (!this.active || !isEffective(this.active, this.flags)) {
        if (this.active?.invalidReason) return { hit: false, reason: `开关已联动失效（${this.active.invalidReason.sourceKey} ${this.active.invalidReason.event}）` };
        return { hit: false, reason: '开关未启用或上游未生效' };
      }
      const flag = this.active;
      const rule = flag.rules;
      if (rule.region !== '全部' && rule.region !== user.region) return { hit: false, reason: `地区不匹配（要求${rule.region}）` };
      if (rule.authenticated && !user.authenticated) return { hit: false, reason: '要求已登录用户' };
      const hash = [...user.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 100;
      const hit = hash < flag.rollout;
      return { hit, reason: hit ? `灰度桶 ${hash} < ${flag.rollout}%` : `灰度桶 ${hash} ≥ ${flag.rollout}%` };
    }
  }
});
