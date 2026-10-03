import { createServer } from 'vite';

// localStorage polyfill for Node
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k)
};

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { createPinia, setActivePinia } = await server.ssrLoadModule('pinia');
const { useFlagStore } = await server.ssrLoadModule('/workspace/src/stores/flags.ts');

setActivePinia(createPinia());
const s = useFlagStore();

const results = [];
function check(name, cond) { results.push([name, !!cond]); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); }

// 1. 按顺序分配总名额：G-001 总名额 60，f1 申请 30 → 占位；f2 申请 50 → 待放行
const g1 = s.groups.find((g) => g.id === 'g1');
const m1 = g1.members.find((m) => m.flagId === 'f1');
const m2 = g1.members.find((m) => m.flagId === 'f2');
check('分配：f1 占位 30', m1.allocated === 30 && m1.status === 'allocated');
check('分配：f2 待放行（申请50 > 剩余30）', m2.allocated === 0 && m2.status === 'pending');

// 2. 上游停用 → 下游立即失效，整组审批作废
s.select('f1');
s.emergencyStop();
const f2 = s.flags.find((f) => f.id === 'f2');
check('上游停用：f2 立即失效', f2.status === 'invalid' && f2.enabled === false);
check('上游停用：g1 整组作废、审批清空', g1.status === 'voided' && g1.approvals.length === 0);
check('上游停用：f2 成员状态 invalid', m2.status === 'invalid');

// 3. 恢复上游 → 下游解除失效，成员占位恢复（超额成员仍待放行）
s.select('f1');
s.active.status = 'approved';
s.startRollout();
s.revalidateFlag(f2.id);
check('恢复：f2 解除失效', f2.status === 'draft');
check('恢复：f1 成员恢复占位 30', m1.status === 'allocated' && m1.allocated === 30);
check('恢复：f2 成员仍待放行（申请50 > 剩余30）', m2.status === 'pending' && m2.allocated === 0);

// 4. 事务性写入：f1 强制失败 → 已启动成员回滚，组 failed，原编号重试
s.toggleForceFail(g1.id, m1.id);
s.approveGroup(g1.id, '产品负责人');
s.approveGroup(g1.id, '研发负责人');
check('审批后 g1 approved', g1.status === 'approved');
const codeBefore = g1.code;
await s.startGroup(g1.id);
check('失败：g1 状态 failed', g1.status === 'failed');
check('失败：f1 成员 failed', m1.status === 'failed');
check('失败：f1 开关恢复启动前状态（rolling）', s.flags.find((f) => f.id === 'f1').status === 'rolling' && s.flags.find((f) => f.id === 'f1').enabled === true);
s.toggleForceFail(g1.id, m1.id); // 取消强制失败
await s.startGroup(g1.id);
check('重试：编号不变', g1.code === codeBefore);
check('重试：g1 完成 active', g1.status === 'active');
check('重试：f1 成员 active', m1.status === 'active');
check('重试：f1 开关已启用', s.flags.find((f) => f.id === 'f1').enabled === true);

// 5. 审计幂等：同一动作只记一次
const startAudits = s.auditLogs.filter((a) => a.dedupKey === `group:start:${g1.id}`);
check('幂等：开始联动发布仅 1 条', startAudits.length === 1);
const writeAudits = s.auditLogs.filter((a) => a.dedupKey === `group:write:${g1.id}:${m1.id}`);
check('幂等：成员写入仅 1 条', writeAudits.length === 1);
const doneAudits = s.auditLogs.filter((a) => a.dedupKey === `group:done:${g1.id}`);
check('幂等：完成审计 1 条', doneAudits.length === 1);

// 6. 规则改动同样触发失效
s.select('f1');
s.active.status = 'rolling';
s.updateRule({ region: '北京' });
check('规则改动：f2 失效', f2.status === 'invalid');
check('规则改动：g1 作废', g1.status === 'voided');

// 7. 依赖环检测
check('环检测：f1→f2 被拒绝（f2→f1 已存在）', (() => { const before = s.dependencies.length; s.addDependency('f1', 'f2'); return s.dependencies.length === before; })());

await server.close();
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
