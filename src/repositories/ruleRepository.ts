import type { BusinessRule, RuleField, RuleProject, RuleVersion, WorkspaceDocument } from '../models/ruleModel';
import { defaultSample } from '../domain/conditionEvaluator';
import { ProjectStorageService } from '../services/projectStorageService';

export type WorkspaceLoadOutcome =
  | { status: 'empty' }
  | { status: 'loaded'; workspace: WorkspaceDocument; repairs: string[] }
  | { status: 'unreadable'; reason: string };

interface WorkspaceDecode {
  workspace: WorkspaceDocument;
  repairs: string[];
}

interface ProjectDecode {
  project: RuleProject;
  repairs: string[];
}

export class RuleRepository {
  constructor(private readonly storage: ProjectStorageService) {}

  async load(): Promise<WorkspaceLoadOutcome> {
    const candidates: unknown[] = [await this.storage.read(), this.storage.readFallback()];
    let sawStoredValue = false;
    for (const candidate of candidates) {
      if (candidate === null || candidate === undefined) continue;
      sawStoredValue = true;
      const decoded = decodeWorkspace(candidate);
      if (decoded) return { status: 'loaded', workspace: decoded.workspace, repairs: decoded.repairs };
    }
    // Stored content exists but nothing could be decoded: report it instead of
    // letting the caller reseed the demo project over the user's data.
    return sawStoredValue
      ? { status: 'unreadable', reason: '存储内容不是可识别的规则工作区' }
      : { status: 'empty' };
  }

  save(document: WorkspaceDocument): Promise<void> {
    return this.storage.write(document);
  }
}

function decodeWorkspace(value: unknown): WorkspaceDecode | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.projects)) return null;
  const repairs: string[] = [];
  const projects: RuleProject[] = [];
  value.projects.forEach((valueProject, index) => {
    const decoded = decodeProject(valueProject);
    if (!decoded) {
      repairs.push(`已跳过 1 个无法识别的项目（${describeProject(valueProject, index)}）`);
      return;
    }
    projects.push(decoded.project);
    repairs.push(...decoded.repairs);
  });
  if (!projects.length) return null;
  const storedActiveId = typeof value.activeProjectId === 'string' ? value.activeProjectId : '';
  let activeProjectId = storedActiveId;
  if (!projects.some((project) => project.id === activeProjectId)) {
    repairs.push(`原活动项目已不可用，已切换到「${projects[0].title}」`);
    activeProjectId = projects[0].id;
  }
  return { workspace: { schemaVersion: 1, projects, activeProjectId }, repairs };
}

function decodeProject(value: unknown): ProjectDecode | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return null;
  const repairs: string[] = [];
  const title = typeof value.title === 'string' && value.title ? value.title : '未命名项目';
  const label = `项目「${title}」`;
  const fieldsValue = Array.isArray(value.fields) ? value.fields : [];
  const fields = fieldsValue.filter(isRuleField);
  if (fields.length !== fieldsValue.length) repairs.push(`${label}：已跳过 ${fieldsValue.length - fields.length} 个无法识别的字段`);
  const rulesValue = Array.isArray(value.rules) ? value.rules : [];
  const rules = rulesValue.filter(isBusinessRule);
  if (rules.length !== rulesValue.length) repairs.push(`${label}：已跳过 ${rulesValue.length - rules.length} 条无法识别的规则`);
  const versionsValue = Array.isArray(value.versions) ? value.versions : [];
  const versions = versionsValue.filter(isRuleVersion);
  if (versions.length !== versionsValue.length) repairs.push(`${label}：已跳过 ${versionsValue.length - versions.length} 条无法识别的版本记录`);
  const project: RuleProject = {
    id: value.id,
    title,
    fields,
    rules,
    sampleInputs: isRecord(value.sampleInputs) ? value.sampleInputs as RuleProject['sampleInputs'] : defaultSample(fields),
    versions,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
  };
  if (typeof value.frozenVersionId === 'string') {
    if (versions.some((version) => version.id === value.frozenVersionId)) {
      project.frozenVersionId = value.frozenVersionId;
    } else {
      repairs.push(`${label}：冻结指向的版本记录已损坏，已解除冻结状态`);
    }
  }
  return { project, repairs };
}

function describeProject(value: unknown, index: number): string {
  return isRecord(value) && typeof value.title === 'string' && value.title ? `「${value.title}」` : `第 ${index + 1} 条记录`;
}

function isRuleField(value: unknown): value is RuleField {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' && ['number', 'enum', 'boolean'].includes(String(value.type));
}

function isBusinessRule(value: unknown): value is BusinessRule {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.priority === 'number'
    && typeof value.result === 'string'
    && isConditionGroup(value.conditions);
}

function isRuleVersion(value: unknown): value is RuleVersion {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.savedAt === 'number'
    && typeof value.frozen === 'boolean'
    && Array.isArray(value.fields)
    && value.fields.every(isRuleField)
    && Array.isArray(value.rules)
    && value.rules.every(isBusinessRule)
    && isRecord(value.sampleInputs);
}

function isConditionGroup(value: unknown): value is BusinessRule['conditions'] {
  return isRecord(value)
    && value.kind === 'group'
    && (value.operator === 'and' || value.operator === 'or')
    && Array.isArray(value.conditions)
    && value.conditions.every(isCondition);
}

function isCondition(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'group') return isConditionGroup(value);
  return value.kind === 'predicate'
    && typeof value.fieldId === 'string'
    && typeof value.operator === 'string'
    && ['eq', 'notEq', 'gt', 'gte', 'lt', 'lte', 'between', 'isTrue', 'isFalse'].includes(value.operator)
    && (typeof value.value === 'string' || typeof value.value === 'number' || typeof value.value === 'boolean' || isRecord(value.value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
