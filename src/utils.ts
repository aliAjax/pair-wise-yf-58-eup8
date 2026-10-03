export function statusColor(status?: string): string {
  switch (status) {
    case 'rolling':
    case 'active':
      return 'green';
    case 'approved':
    case 'allocated':
      return 'blue';
    case 'releasing':
    case 'started':
      return 'geekblue';
    case 'scheduled':
      return 'cyan';
    case 'stopped':
    case 'rolled-back':
    case 'failed':
    case 'invalid':
    case 'voided':
      return 'red';
    default:
      return 'default';
  }
}

export const memberStatusLabel: Record<string, string> = {
  pending: '待放行',
  allocated: '已占位',
  started: '已启动',
  active: '已生效',
  failed: '写入失败',
  invalid: '已失效'
};

export const groupStatusLabel: Record<string, string> = {
  draft: '草稿',
  approved: '已审批',
  releasing: '发布中',
  active: '已完成',
  failed: '失败待重试',
  voided: '已作废'
};
