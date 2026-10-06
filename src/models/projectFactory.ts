import type { BusinessRule, RuleProject, RuleVersion, WorkspaceDocument } from './ruleModel';

export function createDemoWorkspace(): WorkspaceDocument {
  const fields: RuleProject['fields'] = [
    { id: 'member-level', name: '会员等级', type: 'enum', enumValues: ['普通会员', '银卡会员', '金卡会员'] },
    { id: 'cart-total', name: '订单金额', type: 'number', min: 0, max: 5000 },
    { id: 'coupon-active', name: '使用优惠券', type: 'boolean' },
  ];
  const rule = (id: string, name: string, priority: number, result: string, conditions: BusinessRule['conditions']): BusinessRule => ({ id, name, priority, result, conditions });
  const rules: RuleProject['rules'] = [
    rule('rule-gold-discount', '金卡大额订单', 30, '免运费 · 9 折', { kind: 'group', operator: 'and', conditions: [
      { kind: 'predicate', fieldId: 'member-level', operator: 'eq', value: '金卡会员' },
      { kind: 'predicate', fieldId: 'cart-total', operator: 'gte', value: 1000 },
    ] }),
    rule('rule-coupon-discount', '优惠券订单', 30, '立减 80 元', { kind: 'group', operator: 'and', conditions: [
      { kind: 'predicate', fieldId: 'coupon-active', operator: 'isTrue', value: true },
      { kind: 'predicate', fieldId: 'cart-total', operator: 'gte', value: 800 },
    ] }),
    rule('rule-gold-hidden', '金卡高额加赠', 10, '赠送积分礼包', { kind: 'group', operator: 'and', conditions: [
      { kind: 'predicate', fieldId: 'member-level', operator: 'eq', value: '金卡会员' },
      { kind: 'predicate', fieldId: 'cart-total', operator: 'gte', value: 1500 },
    ] }),
    rule('rule-out-of-range', '超范围人工审核', 40, '转人工审核', { kind: 'group', operator: 'and', conditions: [
      { kind: 'predicate', fieldId: 'cart-total', operator: 'gt', value: 5000 },
    ] }),
  ];
  const project: RuleProject = {
    id: 'project-membership', title: '会员权益与折扣策略', fields, rules,
    sampleInputs: { 'member-level': '金卡会员', 'cart-total': 1200, 'coupon-active': true },
    versions: [], updatedAt: Date.now(),
  };
  return { schemaVersion: 1, projects: [project], activeProjectId: project.id };
}

export function createBlankProject(ordinal: number): RuleProject {
  return { id: makeId('project'), title: `未命名规则项目 ${ordinal}`, fields: [], rules: [], sampleInputs: {}, versions: [], updatedAt: Date.now() };
}

export function createVersionSnapshot(project: RuleProject, name: string, frozen: boolean): RuleVersion {
  return {
    id: makeId('version'), name, savedAt: Date.now(), frozen,
    fields: cloneData(project.fields), rules: cloneData(project.rules), sampleInputs: cloneData(project.sampleInputs),
  };
}

export function cloneData<T>(value: T): T {
  return structuredClone(value);
}

export function makeId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}
