import type { BusinessRule, RuleField, RuleProject, RuleVersion, WorkspaceDocument } from '../models/ruleModel';
import { defaultSample } from '../domain/conditionEvaluator';
import { ProjectStorageService } from '../services/projectStorageService';

export class RuleRepository {
  constructor(private readonly storage: ProjectStorageService) {}

  async load(): Promise<WorkspaceDocument | null> {
    const indexedDbValue = await this.storage.read();
    return decodeWorkspace(indexedDbValue) ?? decodeWorkspace(this.storage.readFallback());
  }

  save(document: WorkspaceDocument): Promise<void> {
    return this.storage.write(document);
  }
}

function decodeWorkspace(value: unknown): WorkspaceDocument | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.projects) || typeof value.activeProjectId !== 'string') return null;
  const projects: RuleProject[] = [];
  for (const valueProject of value.projects) {
    const project = decodeProject(valueProject);
    if (!project) return null;
    projects.push(project);
  }
  if (!projects.length || !projects.some((project) => project.id === value.activeProjectId)) return null;
  return { schemaVersion: 1, projects, activeProjectId: value.activeProjectId };
}

function decodeProject(value: unknown): RuleProject | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.title !== 'string' || !Array.isArray(value.fields) || !Array.isArray(value.rules) || typeof value.updatedAt !== 'number') return null;
  const fields = value.fields.filter(isRuleField);
  const rules = value.rules.filter(isBusinessRule);
  if (fields.length !== value.fields.length || rules.length !== value.rules.length) return null;
  const versionsValue = Array.isArray(value.versions) ? value.versions : [];
  const versions = versionsValue.filter(isRuleVersion);
  if (versions.length !== versionsValue.length) return null;
  const project: RuleProject = {
    id: value.id,
    title: value.title,
    fields,
    rules,
    sampleInputs: isRecord(value.sampleInputs) ? value.sampleInputs as RuleProject['sampleInputs'] : defaultSample(fields),
    versions,
    updatedAt: value.updatedAt,
  };
  if (typeof value.frozenVersionId === 'string') project.frozenVersionId = value.frozenVersionId;
  return project;
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
