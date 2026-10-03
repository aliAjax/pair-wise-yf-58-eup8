import { createServer } from 'vite';

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

// 新建一个组：总名额 80，f1 申请 30（占位），f2 申请 50（占位），两个都分配
s.createGroup('中段失败测试组', 80);
const g = s.activeGroup;
s.addMember(g.id, 'f1', 30);
s.addMember(g.id, 'f2', 50);
const m1 = g.members.find((m) => m.flagId === 'f1');
const m2 = g.members.find((m) => m.flagId === 'f2');
check('预分配：f1 占位 30', m1.allocated === 30);
check('预分配：f2 占位 50', m2.allocated === 50);

// 启动前快照：f1 为 rolling(10%)，f2 为 draft
const f1 = s.flags.find((f) => f.id === 'f1');
const f2 = s.flags.find((f) => f.id === 'f2');
check('启动前：f1 rolling 10%', f1.status === 'rolling' && f1.rollout === 10);
check('启动前：f2 draft', f2.status === 'draft');

// 第二个成员写入失败
s.toggleForceFail(g.id, m2.id);
s.approveGroup(g.id, '产品负责人');
s.approveGroup(g.id, '研发负责人');
await s.startGroup(g.id);

check('失败后：g 状态 failed', g.status === 'failed');
check('失败后：m2 failed', m2.status === 'failed');
check('失败后：m1 已启动成员回滚为 allocated', m1.status === 'allocated');
check('失败后：f1 恢复启动前 rolling 10%', f1.status === 'rolling' && f1.rollout === 10 && f1.enabled === true);
check('失败后：f2 仍为 draft（未写入）', f2.status === 'draft' && f2.enabled === false);

// 取消失败标记，按原编号重试
s.toggleForceFail(g.id, m2.id);
const code = g.code;
await s.startGroup(g.id);
check('重试：编号不变', g.code === code);
check('重试：g 完成', g.status === 'active');
check('重试：m1/m2 均 active', m1.status === 'active' && m2.status === 'active');
check('重试：f1 生效 30%', f1.status === 'rolling' && f1.rollout === 30 && f1.enabled === true);
check('重试：f2 生效 50%', f2.status === 'rolling' && f2.rollout === 50 && f2.enabled === true);

// 幂等：补偿回滚审计只记一次（首次失败时），重试不重复
const rollbackAudits = s.auditLogs.filter((a) => a.dedupKey === `group:rollback:${g.id}:${m1.id}`);
check('幂等：补偿回滚审计仅 1 条', rollbackAudits.length === 1);
const startAudits = s.auditLogs.filter((a) => a.dedupKey === `group:start:${g.id}`);
check('幂等：开始发布审计仅 1 条', startAudits.length === 1);
const writeM1 = s.auditLogs.filter((a) => a.dedupKey === `group:write:${g.id}:${m1.id}`);
const writeM2 = s.auditLogs.filter((a) => a.dedupKey === `group:write:${g.id}:${m2.id}`);
check('幂等：成员写入审计各 1 条', writeM1.length === 1 && writeM2.length === 1);

await server.close();
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
