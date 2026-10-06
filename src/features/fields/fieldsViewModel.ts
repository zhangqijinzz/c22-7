import { defaultSample } from '../../domain/conditionEvaluator';
import type { FieldType, RuleField } from '../../models/ruleModel';
import type { WorkspacePort } from '../../viewmodels/workspacePort';

export class FieldsViewModel {
  constructor(private readonly workspace: WorkspacePort) {}

  addField(type: FieldType): void {
    const project = this.workspace.getSnapshot().project;
    if (!project) return;
    const ordinal = project.fields.length + 1;
    const field: RuleField = type === 'number'
      ? { id: makeId('field'), name: `数值字段 ${ordinal}`, type, min: 0, max: 1000 }
      : type === 'enum'
        ? { id: makeId('field'), name: `枚举字段 ${ordinal}`, type, enumValues: ['选项 A', '选项 B'] }
        : { id: makeId('field'), name: `布尔字段 ${ordinal}`, type };
    this.workspace.commitProject({
      ...project,
      fields: [...project.fields, field],
      sampleInputs: { ...defaultSample(project.fields), ...project.sampleInputs, ...defaultSample([field]) },
    }, `已添加字段“${field.name}”`);
  }

  updateField(fieldId: string, updates: Partial<RuleField>): void {
    const project = this.workspace.getSnapshot().project;
    if (!project) return;
    const fields = project.fields.map((field) => field.id === fieldId ? { ...field, ...updates } : field);
    this.workspace.commitProject({ ...project, fields }, '字段已更新，检查结果将自动刷新');
  }

  removeField(fieldId: string): boolean {
    const project = this.workspace.getSnapshot().project;
    const field = project?.fields.find((candidate) => candidate.id === fieldId);
    if (!project || !field) return false;
    const references = project.rules.filter((rule) => referencesField(rule.conditions, fieldId)).map((rule) => rule.name);
    if (references.length) {
      this.workspace.updateView({ notice: `无法删除“${field.name}”：仍被 ${references.join('、')} 引用。请先移除这些规则条件。` });
      return false;
    }
    const sampleInputs = { ...project.sampleInputs };
    delete sampleInputs[fieldId];
    this.workspace.commitProject({ ...project, fields: project.fields.filter((candidate) => candidate.id !== fieldId), sampleInputs }, `已删除字段“${field.name}”`);
    return true;
  }

  isReferenced(fieldId: string): boolean {
    const project = this.workspace.getSnapshot().project;
    return project?.rules.some((rule) => referencesField(rule.conditions, fieldId)) ?? false;
  }
}

function referencesField(condition: import('../../models/ruleModel').RuleCondition, fieldId: string): boolean {
  return condition.kind === 'group'
    ? condition.conditions.some((child) => referencesField(child, fieldId))
    : condition.fieldId === fieldId;
}

function makeId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}
