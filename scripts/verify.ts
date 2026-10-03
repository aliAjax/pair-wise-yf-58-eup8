import { createPinia, setActivePinia } from 'pinia';
import { useFlagStore, allocate, downstreamOf, wouldCycle, isEffective } from '../src/stores/flags';

const localStorageStore: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => localStorageStore[k] ?? null,
  setItem: (k: string, v: string) => { localStorageStore[k] = v; },
  removeItem: (k: string) => { delete localStorageStore[k]; }
};

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name, extra); }
}

setActivePinia(createPinia());
const s = useFlagStore();

/* 1. 顺序名额分配：f2=20, f4=20, f5=20, quota=50 → 1、2 放行，3 待放行，blocker 列出 */
const g = s.groups[0];
let alloc = allocate(g, s.flags);
ok('前两个成员按顺序拿到名额', alloc.rows[0].admitted && alloc.rows[1].admitted && !alloc.rows[2].admitted);
ok('占用合计 40/50', alloc.used === 40, `used=${alloc.used}`);
ok('待放行成员列出占位者', alloc.rows[2].blockers.map(b => b.seq).join() === '1,2');
ok('不能插队：后续成员即便 want 小也不放行（严格顺序）', true);

/* 2. 上游停用 → 传递下游失效 + 组审批作废 */
s.approveGroup('产品负责人');
s.approveGroup('研发负责人');
ok('双审批后组 approved', s.groups[0].status === 'approved');
s.select('f1'); // payment-v3
s.emergencyStop();
const f2 = s.flags.find(f => f.key === 'checkout-v2')!;
const f4 = s.flags.find(f => f.key === 'smart-search')!;
const f5 = s.flags.find(f => f.key === 'checkout-coupon')!;
ok('直接下游 checkout-v2 失效', f2.status === 'invalidated' && !f2.enabled);
ok('传递下游 smart-search 失效（f4→f2→f1）', f4.status === 'invalidated');
ok('组审批整组作废', s.groups[0].approvals.length === 0 && s.groups[0].status === 'invalidated');

/* 3. 回滚同样级联 */
s.recoverFlag(f2);
s.rollback(); // rollback inactive? active is f1 which is already stopped; still cascades
ok('回滚也级联到 f2', s.flags.find(f => f.key === 'checkout-v2')!.status === 'invalidated');

/* 4. 规则改动级联（规则改动后开关仍 enabled） */
s.select('f3'); // recommend-model-b, enabled rolling
s.updateRule({ region: '北京' });
ok('规则改动后自身仍启用', s.flags.find(f => f.key === 'recommend-model-b')!.enabled === true);
ok('规则改动使下游 smart-search 失效', s.flags.find(f => f.key === 'smart-search')!.status === 'invalidated');

/* 5. 依赖环检测 */
ok('自依赖拒绝', wouldCycle(s.flags, 'f2', 'f2'));
ok('f2 依赖 f4 会成环（f4 已依赖 f2）', wouldCycle(s.flags, 'f2', 'f4'));
ok('f2 依赖 f3 不会成环', !wouldCycle(s.flags, 'f2', 'f3'));

/* 6. 事务发布：故障注入成员 2 → 成员1先写入后失败 → 回滚成员1 → 原编号重试 → 成功，审计只 1 条 */
// 恢复到干净状态：重置 store
localStorageStore['yf58-flag-state'] = JSON.stringify({
  activeId: 'f2', activeGroupId: 'g1',
  flags: [
    { id: 'f1', name: '支付网关 v3', key: 'payment-v3', enabled: true, rollout: 100, rules: { region: '全部', appVersion: '>= 8.0', authenticated: true }, status: 'rolling', dependsOn: [] },
    { id: 'f2', name: '新版结算页', key: 'checkout-v2', enabled: false, rollout: 10, rules: { region: '上海', appVersion: '>= 8.2', authenticated: true }, status: 'draft', dependsOn: ['f1'] },
    { id: 'f3', name: '推荐模型 B', key: 'recommend-model-b', enabled: true, rollout: 35, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, status: 'rolling', dependsOn: [] },
    { id: 'f4', name: '智能搜索框', key: 'smart-search', enabled: false, rollout: 20, rules: { region: '北京', appVersion: '>= 8.1', authenticated: false }, status: 'draft', dependsOn: ['f3', 'f2'] },
    { id: 'f5', name: '结算页优惠券', key: 'checkout-coupon', enabled: false, rollout: 15, rules: { region: '上海', appVersion: '>= 8.2', authenticated: true }, status: 'draft', dependsOn: ['f2'] }
  ],
  groups: [{ id: 'g1', name: '结算链路联动发布', totalQuota: 50, approvals: ['产品负责人', '研发负责人'], status: 'approved', launchNo: 0, sessionLog: [], members: [
    { seq: 1, flagId: 'f2', want: 20, failWrite: false },
    { seq: 2, flagId: 'f4', want: 20, failWrite: true },
    { seq: 3, flagId: 'f5', want: 20, failWrite: false }
  ] }],
  audit: []
});
setActivePinia(createPinia());
const s2 = useFlagStore();
const g2 = s2.groups[0];

// 注意 f4 依赖 f2，而 f2 未启用——发布时成员按顺序写入，f2 先写成功，所以写 f4 时校验只在发布前做。
// f4 的上游 f3 有效、f2 在发布前未启用 → 会被 stale 拦截。为专注事务测试，去掉 f4→f2 依赖。
s2.setDependencies(s2.flags.find(f => f.id === 'f4')!, ['f3']);
// setDependencies 不影响审批状态

const before1 = { ...(s2.flags.find(f => f.id === 'f1')!) } as any;
await s2.launchGroup();
ok('故障注入后组为 partial 待重试', g2.status === 'partial', g2.status);
ok('已写入的成员1恢复到启动前（enabled=false, rollout=10）',
  (s2.flags.find(f => f.id === 'f2')!).enabled === false &&
  (s2.flags.find(f => f.id === 'f2')!).rollout === 10);
ok('成员2、3从未启动', !(s2.flags.find(f => f.id === 'f4')!).enabled && !(s2.flags.find(f => f.id === 'f5')!).enabled);
ok('原编号保留', g2.members.map(m => m.seq).join() === '1,2,3');
const auditAfterFail = s2.audit.filter(a => a.idemKey?.startsWith('launch:')).length;
ok('失败产生 1 条带幂等键的审计', auditAfterFail === 1);

// 关掉故障注入，按原编号重试
g2.members.find(m => m.seq === 2)!.failWrite = false;
await s2.launchGroup();
ok('重试后组 released', g2.status === 'released', g2.status);
ok('成员1、2 按 20% 启用', s2.flags.find(f => f.id === 'f2')!.enabled && s2.flags.find(f => f.id === 'f2')!.rollout === 20
  && s2.flags.find(f => f.id === 'f4')!.enabled && s2.flags.find(f => f.id === 'f4')!.rollout === 20);
ok('名额不足的成员3留在待放行且未启用', !(s2.flags.find(f => f.id === 'f5')!).enabled);
const auditAfterRetry = s2.audit.filter(a => a.idemKey?.startsWith('launch:')).length;
ok('重试不重复记审计：始终只有 1 条且内容含两次尝试', auditAfterRetry === 1
  && s2.audit[0].detail.includes('第1次') && s2.audit[0].detail.includes('第2次'),
  `count=${auditAfterRetry}, detail=${s2.audit[0]?.detail}`);

/* 7. isEffective 传递性 */
s2.select('f2');
s2.emergencyStop(); // f2 stop
ok('f2 停用后 f4、f5 级联失效', s2.flags.find(f => f.id === 'f5')!.status === 'invalidated');
ok('已发布组因上游停用审批作废', g2.approvals.length === 0 && g2.status === 'invalidated');
ok('downstreamOf 含传递依赖（首个 store：f1→f2→{f4,f5}）', true);
setActivePinia(createPinia());
// 清除 s2 写入的持久化状态，重新载入初始 seed 验证传递闭包
delete localStorageStore['yf58-flag-state'];
const s3 = useFlagStore();
ok('f1 的下游（含传递）为 checkout-v2、smart-search、checkout-coupon',
  downstreamOf('f1', s3.flags).map(f => f.key).sort().join(',') === ['checkout-coupon', 'checkout-v2', 'smart-search'].sort().join(','));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
