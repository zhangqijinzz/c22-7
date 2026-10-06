import type { BusinessRule, ConditionGroup, PredicateCondition, RuleField, RuleProject } from '../../models/ruleModel';
import type { WorkspacePort } from '../../viewmodels/workspacePort';

export class RulesViewModel {
  constructor(private readonly workspace: WorkspacePort) {}

  selectRule(ruleId: string): void {
    this.workspace.selectRule(ruleId);
  }

  addRule(): void {
    const project = this.currentProject();
    if (!project) return;
    const ordinal = project.rules.length + 1;
    const field = project.fields.find((candidate) => candidate.type === 'number' || candidate.type === 'enum' || candidate.type === 'boolean');
    const conditions: ConditionGroup = { kind: 'group', operator: 'and', conditions: field ? [defaultCondition(field)] : [] };
    const rule: BusinessRule = { id: makeId('rule'), name: `新规则 ${ordinal}`, conditions, priority: ordinal * 10, result: '' };
    this.workspace.commitProject({ ...project, rules: [...project.rules, rule] }, `已创建“${rule.name}”`);
    this.workspace.selectRule(rule.id);
  }

  updateRule(ruleId: string, updates: Partial<Pick<BusinessRule, 'name' | 'priority' | 'result'>>): void {
    this.updateRules((rule) => rule.id === ruleId ? { ...rule, ...updates } : rule, `${this.findName(ruleId)}已更新`);
  }

  removeRule(ruleId: string): void {
    const project = this.currentProject();
    if (!project) return;
    const name = this.findName(ruleId);
    this.workspace.commitProject({ ...project, rules: project.rules.filter((rule) => rule.id !== ruleId) }, `已删除${name}`);
    if (this.workspace.getSnapshot().selectedRuleId === ruleId) this.workspace.selectRule(project.rules.find((rule) => rule.id !== ruleId)?.id);
  }

  setGroupOperator(ruleId: string, operator: ConditionGroup['operator']): void {
    this.updateRules((rule) => rule.id === ruleId ? { ...rule, conditions: { ...rule.conditions, operator } } : rule, '条件组合已更新');
  }

  addCondition(ruleId: string): void {
    const project = this.currentProject();
    const field = project?.fields[0];
    if (!project || !field) {
      this.workspace.updateView({ notice: '请先定义至少一个字段，再添加规则条件。' });
      return;
    }
    this.updateRules((rule) => rule.id === ruleId
      ? { ...rule, conditions: { ...rule.conditions, conditions: [...rule.conditions.conditions, defaultCondition(field)] } }
      : rule, '已添加一个条件');
  }

  updateCondition(ruleId: string, index: number, condition: PredicateCondition): void {
    this.updateRules((rule) => {
      if (rule.id !== ruleId) return rule;
      const conditions = [...rule.conditions.conditions];
      conditions[index] = condition;
      return { ...rule, conditions: { ...rule.conditions, conditions } };
    }, '规则条件已更新');
  }

  changeConditionField(ruleId: string, index: number, fieldId: string): void {
    const field = this.currentProject()?.fields.find((candidate) => candidate.id === fieldId);
    if (field) this.updateCondition(ruleId, index, defaultCondition(field));
  }

  removeCondition(ruleId: string, index: number): void {
    this.updateRules((rule) => rule.id === ruleId
      ? { ...rule, conditions: { ...rule.conditions, conditions: rule.conditions.conditions.filter((_, itemIndex) => itemIndex !== index) } }
      : rule, '已移除一个条件');
  }

  private currentProject(): RuleProject | null {
    return this.workspace.getSnapshot().project;
  }

  private findName(ruleId: string): string {
    return this.currentProject()?.rules.find((rule) => rule.id === ruleId)?.name ?? '规则';
  }

  private updateRules(update: (rule: BusinessRule) => BusinessRule, notice: string): void {
    const project = this.currentProject();
    if (project) this.workspace.commitProject({ ...project, rules: project.rules.map(update) }, notice);
  }
}

function defaultCondition(field: RuleField): PredicateCondition {
  if (field.type === 'number') return { kind: 'predicate', fieldId: field.id, operator: 'gte', value: field.min ?? 0 };
  if (field.type === 'enum') return { kind: 'predicate', fieldId: field.id, operator: 'eq', value: field.enumValues?.[0] ?? '' };
  return { kind: 'predicate', fieldId: field.id, operator: 'isTrue', value: true };
}

function makeId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}
