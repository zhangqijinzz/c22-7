import type {
  BusinessRule,
  ConditionGroup,
  PredicateCondition,
  RuleCondition,
  RuleField,
  RuleProject,
  RuleVersion,
  SampleInput,
  StorageSourceName,
  WorkspaceDocument,
  WorkspaceLoadResult,
  RecoveryIssue,
  RawStorageSnapshot,
} from '../models/ruleModel';
import { defaultSample } from '../domain/conditionEvaluator';
import type { ProjectStorageService } from '../services/projectStorageService';

type RecoveryStorage = Pick<ProjectStorageService, 'readSources' | 'preserveRawSources' | 'write'>;

interface DecodedSource {
  source: StorageSourceName;
  fatal: boolean;
  fatalMessage?: string;
  legacy: boolean;
  document?: WorkspaceDocument;
  issues: RecoveryIssue[];
  issueCount: number;
}

export class RuleRepository {
  private pendingRawSnapshots: RawStorageSnapshot[] = [];
  private pendingSkipWriteSources: StorageSourceName[] = [];

  constructor(private readonly storage: RecoveryStorage) {}

  async load(): Promise<WorkspaceLoadResult | null> {
    const states = await this.storage.readSources();
    if (states.every((state) => state.status === 'absent')) return null;

    const rawSources: RawStorageSnapshot[] = [];
    const decoded: DecodedSource[] = [];
    const unreadableSources: StorageSourceName[] = [];
    for (const state of states) {
      if (state.status === 'absent') continue;
      if (state.status === 'unreadable') {
        unreadableSources.push(state.source);
        rawSources.push({ source: state.source, value: { parseError: state.message, rawText: state.rawText ?? null } });
        decoded.push({
          source: state.source, fatal: true, legacy: false,
          fatalMessage: state.message,
          issues: [issue('storage', 'error', `${sourceLabel(state.source)}中的内容无法解析，未用演示数据覆盖`, state.source)],
          issueCount: 1,
        });
        continue;
      }
      rawSources.push({ source: state.source, value: state.value });
      decoded.push(decodeStoredWorkspace(state.value, state.source));
    }

    const candidates = decoded.filter((candidate) => !candidate.fatal && candidate.document);
    if (!candidates.length) {
      const first = decoded[0];
      return {
        fatal: true,
        message: first?.fatalMessage ?? '本地工作区无法识别，已停止自动恢复',
        issues: decoded.flatMap((candidate) => candidate.issues),
        rawSources,
        skipWriteSources: unreadableSources,
      };
    }

    candidates.sort((a, b) => sourceScore(b) - sourceScore(a) || sourceRank(b.source) - sourceRank(a.source));
    const selected = candidates[0];
    const issues = [...selected.issues];
    for (const candidate of decoded.filter((item) => item.source !== selected.source)) {
      if (candidate.fatal) {
        issues.push(issue('storage', 'error', `${sourceLabel(candidate.source)}无法识别，当前先从${sourceLabel(selected.source)}恢复；保存前会备份原始数据`, candidate.source));
      } else if (candidate.document && !documentsEqual(candidate.document, selected.document as WorkspaceDocument)) {
        issues.push(issue('storage', 'warning', `${sourceLabel(candidate.source)}与${sourceLabel(selected.source)}内容不一致，当前打开${sourceLabel(selected.source)}；保存前会备份两份原始数据`, candidate.source));
      }
      if (!candidate.fatal && candidate.issueCount > 0) {
        issues.push(issue('storage', 'warning', `${sourceLabel(candidate.source)}另有 ${candidate.issueCount} 处无法识别的内容，原始数据将在保存前备份`, candidate.source));
      }
    }

    const requiresPreservation = issues.some((item) => item.severity === 'error') || selected.legacy || issues.length > 0;
    this.pendingRawSnapshots = requiresPreservation ? rawSources : [];
    this.pendingSkipWriteSources = requiresPreservation ? unreadableSources.filter((source) => source !== selected.source) : [];
    return {
      fatal: false,
      document: selected.document as WorkspaceDocument,
      issues,
      legacy: selected.legacy,
      rawSources,
      skipWriteSources: unreadableSources.filter((source) => source !== selected.source),
    };
  }

  async prepareRecoveredSourcesForSave(): Promise<void> {
    if (!this.pendingRawSnapshots.length) return;
    await this.storage.preserveRawSources(this.pendingRawSnapshots);
    this.pendingRawSnapshots = [];
  }

  async save(document: WorkspaceDocument): Promise<void> {
    await this.prepareRecoveredSourcesForSave();
    await this.storage.write(document, { skipSources: this.pendingSkipWriteSources });
    this.pendingSkipWriteSources = [];
  }
}

function decodeStoredWorkspace(value: unknown, source: StorageSourceName): DecodedSource {
  const issues: RecoveryIssue[] = [];
  if (!isRecord(value)) {
    return fatalSource(source, '本地工作区不是有效的对象结构', issues);
  }

  const legacy = value.schemaVersion !== 1;
  if (legacy) {
    issues.push(issue('workspace', 'warning', value.schemaVersion === undefined
      ? `${sourceLabel(source)}来自较早版本（缺少 schemaVersion），已尝试按当前结构补全`
      : `${sourceLabel(source)}的 schemaVersion 为 ${String(value.schemaVersion)}，已尝试按 v1 结构兼容恢复`, source));
  }
  if (!Array.isArray(value.projects)) {
    return fatalSource(source, '本地工作区缺少 projects 项目列表，无法安全恢复', issues);
  }

  const usedProjectIds = new Set<string>();
  const projects: RuleProject[] = [];
  value.projects.forEach((rawProject, index) => {
    const decoded = decodeProject(rawProject, index, source, usedProjectIds);
    issues.push(...decoded.issues);
    if (decoded.project) projects.push(decoded.project);
  });

  if (!projects.length) {
    return fatalSource(source, '本地工作区没有可恢复的项目，已停止自动恢复', issues);
  }

  let activeProjectId = typeof value.activeProjectId === 'string' ? value.activeProjectId : '';
  if (!activeProjectId) {
    activeProjectId = projects[0].id;
    issues.push(issue('workspace', 'warning', '工作区缺少有效的 activeProjectId，已打开第一个可恢复项目', source));
  } else if (!projects.some((project) => project.id === activeProjectId)) {
    issues.push(issue('workspace', 'warning', `当前项目 ID“${activeProjectId}”对应项目无法恢复，已打开第一个可恢复项目`, source));
    activeProjectId = projects[0].id;
  }

  return {
    source, fatal: false, legacy,
    document: { schemaVersion: 1, projects, activeProjectId },
    issues, issueCount: issues.length,
  };
}

interface ProjectDecodeResult {
  project?: RuleProject;
  issues: RecoveryIssue[];
}

function decodeProject(rawProject: unknown, index: number, source: StorageSourceName, usedProjectIds: Set<string>): ProjectDecodeResult {
  const issues: RecoveryIssue[] = [];
  if (!isRecord(rawProject)) {
    issues.push(issue('project', 'error', `第 ${index + 1} 个项目不是有效对象，已只跳过这一条`, source));
    return { issues };
  }

  const id = restoreId(rawProject.id, 'project', index, usedProjectIds, '项目', source, issues);
  const title = typeof rawProject.title === 'string' && rawProject.title.trim()
    ? rawProject.title
    : defaultName(issues, 'project', id, rawProject.title === undefined ? '项目缺少标题，已暂存为“未命名恢复项目”' : '项目标题无效，已暂存为“未命名恢复项目”', '未命名恢复项目', source);

  const usedFieldIds = new Set<string>();
  const fields: RuleField[] = [];
  if (rawProject.fields === undefined) {
    issues.push(issue('field', 'warning', `项目“${title}”缺少字段列表，已按空字段恢复`, source, id));
  } else if (!Array.isArray(rawProject.fields)) {
    issues.push(issue('field', 'error', `项目“${title}”的字段列表损坏，已按空字段恢复`, source, id));
  } else {
    rawProject.fields.forEach((rawField, fieldIndex) => {
      const decoded = decodeField(rawField, fieldIndex, title, source, id, usedFieldIds);
      issues.push(...decoded.issues);
      if (decoded.field) fields.push(decoded.field);
    });
  }

  const usedRuleIds = new Set<string>();
  const rules: BusinessRule[] = [];
  if (rawProject.rules === undefined) {
    issues.push(issue('rule', 'warning', `项目“${title}”缺少规则列表，已按空规则恢复`, source, id));
  } else if (!Array.isArray(rawProject.rules)) {
    issues.push(issue('rule', 'error', `项目“${title}”的规则列表损坏，已按空规则恢复`, source, id));
  } else {
    rawProject.rules.forEach((rawRule, ruleIndex) => {
      const decoded = decodeRule(rawRule, ruleIndex, title, fields, source, id, usedRuleIds);
      issues.push(...decoded.issues);
      if (decoded.rule) rules.push(decoded.rule);
    });
  }

  const versions: RuleVersion[] = [];
  if (rawProject.versions !== undefined && !Array.isArray(rawProject.versions)) {
    issues.push(issue('version', 'error', `项目“${title}”的版本列表损坏，已只跳过无法识别的版本列表内容`, source, id));
  } else if (Array.isArray(rawProject.versions)) {
    const usedVersionIds = new Set<string>();
    rawProject.versions.forEach((rawVersion, versionIndex) => {
      const decoded = decodeVersion(rawVersion, versionIndex, title, source, id, usedVersionIds);
      issues.push(...decoded.issues);
      if (decoded.version) versions.push(decoded.version);
    });
  }

  const sampleInputs = decodeSampleInputs(rawProject.sampleInputs, fields, `项目“${title}”`, source, id, 'project', issues);
  const updatedAt = typeof rawProject.updatedAt === 'number' && Number.isFinite(rawProject.updatedAt)
    ? rawProject.updatedAt
    : Date.now();
  if (!(typeof rawProject.updatedAt === 'number' && Number.isFinite(rawProject.updatedAt))) {
    issues.push(issue('project', 'warning', `项目“${title}”缺少有效更新时间，已使用当前时间补全`, source, id));
  }

  const project: RuleProject = { id, title, fields, rules, sampleInputs, versions, updatedAt };
  if (typeof rawProject.frozenVersionId === 'string') {
    if (versions.some((version) => version.id === rawProject.frozenVersionId)) project.frozenVersionId = rawProject.frozenVersionId;
    else issues.push(issue('version', 'warning', `项目“${title}”引用的冻结版本不存在，已解除损坏的冻结标记`, source, id, rawProject.frozenVersionId));
  } else if (rawProject.frozenVersionId !== undefined) {
    issues.push(issue('version', 'warning', `项目“${title}”的冻结版本 ID 无效，已忽略该标记`, source, id));
  }
  return { project, issues };
}

interface FieldDecodeResult { field?: RuleField; issues: RecoveryIssue[] }

function decodeField(
  rawField: unknown,
  index: number,
  projectTitle: string,
  source: StorageSourceName,
  projectId: string,
  usedIds: Set<string>,
): FieldDecodeResult {
  if (!isRecord(rawField)) {
    return { issues: [issue('field', 'error', `项目“${projectTitle}”中第 ${index + 1} 个字段不是有效对象，已只跳过该字段`, source, projectId)] };
  }
  const issues: RecoveryIssue[] = [];
  const id = restoreId(rawField.id, 'field', index, usedIds, '字段', source, issues, projectId);
  const name = typeof rawField.name === 'string' && rawField.name.trim()
    ? rawField.name
    : defaultName(issues, 'field', id, `字段 ${labelOf(rawField.id, index + 1)} 缺少有效名称，已暂存为“未命名字段”`, '未命名字段', source, projectId);
  const type = decodeFieldType(rawField.type, name, issues, source, projectId);

  const field: RuleField = { id, name, type };
  if (type === 'number') {
    if (typeof rawField.min === 'number' && Number.isFinite(rawField.min)) field.min = rawField.min;
    else if (rawField.min !== undefined) issues.push(issue('field', 'warning', `字段“${name}”的最小值无效，已忽略`, source, projectId, id));
    if (typeof rawField.max === 'number' && Number.isFinite(rawField.max)) field.max = rawField.max;
    else if (rawField.max !== undefined) issues.push(issue('field', 'warning', `字段“${name}”的最大值无效，已忽略`, source, projectId, id));
    if (field.min === undefined || field.max === undefined) {
      field.min ??= 0;
      field.max ??= 100;
      issues.push(issue('field', 'warning', `字段“${name}”缺少完整数值范围，已暂设为 0 到 100`, source, projectId, id));
    }
  }
  if (type === 'enum') {
    const values = Array.isArray(rawField.enumValues) ? rawField.enumValues : [];
    if (!Array.isArray(rawField.enumValues)) {
      issues.push(issue('field', 'warning', `字段“${name}”的枚举选项损坏，已暂设一个选项`, source, projectId, id));
    }
    const enumValues = values.flatMap((value, optionIndex) => {
      if (typeof value === 'string' && value.trim()) return [value];
      issues.push(issue('field', 'warning', `字段“${name}”的第 ${optionIndex + 1} 个枚举选项无效，已只跳过该选项`, source, projectId, id));
      return [];
    });
    field.enumValues = enumValues.length ? enumValues : ['选项 1'];
    if (!enumValues.length) issues.push(issue('field', 'warning', `字段“${name}”没有有效枚举选项，已暂设“选项 1”`, source, projectId, id));
  } else if (rawField.enumValues !== undefined) {
    issues.push(issue('field', 'warning', `字段“${name}”不是枚举字段，已忽略损坏的 enumValues`, source, projectId, id));
  }
  return { field, issues };
}

interface RuleDecodeResult { rule?: BusinessRule; issues: RecoveryIssue[] }

function decodeRule(
  rawRule: unknown,
  index: number,
  projectTitle: string,
  fields: RuleField[],
  source: StorageSourceName,
  projectId: string,
  usedIds: Set<string>,
): RuleDecodeResult {
  if (!isRecord(rawRule)) {
    return { issues: [issue('rule', 'error', `项目“${projectTitle}”中第 ${index + 1} 条规则不是有效对象，已只跳过该规则`, source, projectId)] };
  }
  const issues: RecoveryIssue[] = [];
  const id = restoreId(rawRule.id, 'rule', index, usedIds, '规则', source, issues, projectId);
  const name = typeof rawRule.name === 'string' && rawRule.name.trim()
    ? rawRule.name
    : defaultName(issues, 'rule', id, `规则 ${labelOf(rawRule.id, index + 1)} 缺少有效名称，已暂存为“未命名规则”`, '未命名规则', source, projectId);
  const priority = typeof rawRule.priority === 'number' && Number.isFinite(rawRule.priority)
    ? rawRule.priority
    : 0;
  if (!(typeof rawRule.priority === 'number' && Number.isFinite(rawRule.priority))) {
    issues.push(issue('rule', 'warning', `规则“${name}”缺少有效优先级，已暂设为 0`, source, projectId, id));
  }
  const result = typeof rawRule.result === 'string' ? rawRule.result : '';
  if (typeof rawRule.result !== 'string') issues.push(issue('rule', 'warning', `规则“${name}”缺少决策结果，已留空并标记为待修复`, source, projectId, id));
  const conditionResult = decodeConditionGroup(rawRule.conditions, fields, name, source, projectId, id, issues);

  return { rule: { id, name, priority, result, conditions: conditionResult }, issues };
}

interface VersionDecodeResult { version?: RuleVersion; issues: RecoveryIssue[] }

function decodeVersion(
  rawVersion: unknown,
  index: number,
  projectTitle: string,
  source: StorageSourceName,
  projectId: string,
  usedIds: Set<string>,
): VersionDecodeResult {
  if (!isRecord(rawVersion)) {
    return { issues: [issue('version', 'error', `项目“${projectTitle}”中第 ${index + 1} 条版本记录不是有效对象，已只跳过该版本`, source, projectId)] };
  }
  const issues: RecoveryIssue[] = [];
  const id = restoreId(rawVersion.id, 'version', index, usedIds, '版本', source, issues, projectId);
  const name = typeof rawVersion.name === 'string' && rawVersion.name.trim()
    ? rawVersion.name
    : defaultName(issues, 'version', id, `版本 ${labelOf(rawVersion.id, index + 1)} 缺少名称，已暂存为“恢复版本”`, '恢复版本', source, projectId);
  const savedAt = typeof rawVersion.savedAt === 'number' && Number.isFinite(rawVersion.savedAt)
    ? rawVersion.savedAt
    : Date.now();
  if (!(typeof rawVersion.savedAt === 'number' && Number.isFinite(rawVersion.savedAt))) {
    issues.push(issue('version', 'warning', `版本“${name}”缺少有效保存时间，已使用当前时间补全`, source, projectId, id));
  }
  const frozen = typeof rawVersion.frozen === 'boolean' ? rawVersion.frozen : false;
  if (typeof rawVersion.frozen !== 'boolean') issues.push(issue('version', 'warning', `版本“${name}”缺少 frozen 标记，已按未冻结处理`, source, projectId, id));

  const versionFields: RuleField[] = [];
  if (rawVersion.fields === undefined) {
    issues.push(issue('field', 'warning', `版本“${name}”缺少字段快照，已按空字段恢复`, source, projectId, id));
  } else if (!Array.isArray(rawVersion.fields)) {
    issues.push(issue('field', 'error', `版本“${name}”的字段快照损坏，已按空字段恢复`, source, projectId, id));
  } else {
    const usedFieldIds = new Set<string>();
    rawVersion.fields.forEach((rawField, fieldIndex) => {
      const decoded = decodeField(rawField, fieldIndex, projectTitle, source, id, usedFieldIds);
      issues.push(...decoded.issues);
      if (decoded.field) versionFields.push(decoded.field);
    });
  }

  const versionRules: BusinessRule[] = [];
  if (rawVersion.rules === undefined) {
    issues.push(issue('rule', 'warning', `版本“${name}”缺少规则快照，已按空规则恢复`, source, projectId, id));
  } else if (!Array.isArray(rawVersion.rules)) {
    issues.push(issue('rule', 'error', `版本“${name}”的规则快照损坏，已按空规则恢复`, source, projectId, id));
  } else {
    const usedRuleIds = new Set<string>();
    rawVersion.rules.forEach((rawRule, ruleIndex) => {
      const decoded = decodeRule(rawRule, ruleIndex, projectTitle, versionFields, source, id, usedRuleIds);
      issues.push(...decoded.issues);
      if (decoded.rule) versionRules.push(decoded.rule);
    });
  }

  const sampleInputs = decodeSampleInputs(rawVersion.sampleInputs, versionFields, `版本“${name}”`, source, id, 'version', issues);
  return { version: { id, name, savedAt, frozen, fields: versionFields, rules: versionRules, sampleInputs }, issues };
}

function decodeConditionGroup(
  rawGroup: unknown,
  fields: RuleField[],
  ownerName: string,
  source: StorageSourceName,
  projectId: string,
  ruleId: string,
  issues: RecoveryIssue[],
): ConditionGroup {
  if (!isRecord(rawGroup)) {
    issues.push(issue('rule', 'error', `规则“${ownerName}”的条件组损坏，已保留规则并清空损坏条件`, source, projectId, ruleId));
    return { kind: 'group', operator: 'and', conditions: [] };
  }
  const operator = normalizeOperator(rawGroup.operator, ownerName, source, projectId, ruleId, issues);
  if (!Array.isArray(rawGroup.conditions)) {
    issues.push(issue('rule', 'error', `规则“${ownerName}”的条件列表损坏，已只跳过损坏条件`, source, projectId, ruleId));
    return { kind: 'group', operator, conditions: [] };
  }
  const conditions: RuleCondition[] = [];
  rawGroup.conditions.forEach((rawCondition) => {
    const condition = decodeCondition(rawCondition, fields, ownerName, source, projectId, ruleId, issues);
    if (condition) conditions.push(condition);
  });
  return { kind: 'group', operator, conditions };
}

function decodeCondition(
  rawCondition: unknown,
  fields: RuleField[],
  ownerName: string,
  source: StorageSourceName,
  projectId: string,
  ruleId: string,
  issues: RecoveryIssue[],
): RuleCondition | null {
  if (!isRecord(rawCondition)) {
    issues.push(issue('rule', 'error', `规则“${ownerName}”中存在非对象条件，已只跳过该条件`, source, projectId, ruleId));
    return null;
  }
  if (rawCondition.kind === 'group') {
    return decodeConditionGroup(rawCondition, fields, ownerName, source, projectId, ruleId, issues);
  }
  if (rawCondition.kind !== 'predicate') {
    issues.push(issue('rule', 'error', `规则“${ownerName}”中存在未知条件类型，已只跳过该条件`, source, projectId, ruleId));
    return null;
  }
  const fieldId = typeof rawCondition.fieldId === 'string' ? rawCondition.fieldId : '';
  if (!fieldId) issues.push(issue('rule', 'warning', `规则“${ownerName}”中某条件缺少 fieldId，已保留并标记为待修复`, source, projectId, ruleId));
  const operator = normalizePredicateOperator(rawCondition.operator, ownerName, source, projectId, ruleId, issues);
  const field = fields.find((candidate) => candidate.id === fieldId);
  const value = decodePredicateValue(rawCondition.value, operator, field?.type, ownerName, source, projectId, ruleId, issues);
  return { kind: 'predicate', fieldId, operator, value } as RuleCondition;
}

function decodeSampleInputs(
  rawInputs: unknown,
  fields: RuleField[],
  ownerLabel: string,
  source: StorageSourceName,
  ownerId: string,
  scope: 'project' | 'version',
  issues: RecoveryIssue[],
): SampleInput {
  if (rawInputs === undefined) {
    issues.push(issue(scope, 'warning', `${ownerLabel}缺少样例输入，已按字段默认值补全`, source, ownerId));
    return defaultSample(fields);
  }
  if (!isRecord(rawInputs)) {
    issues.push(issue(scope, 'error', `${ownerLabel}的样例输入损坏，已只重置这部分数据`, source, ownerId));
    return defaultSample(fields);
  }
  const sampleInputs: SampleInput = {};
  for (const [key, value] of Object.entries(rawInputs)) {
    if (value === '' || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      sampleInputs[key] = value;
    } else {
      issues.push(issue(scope, 'warning', `${ownerLabel}中样例“${key}”的值类型无效，已只跳过该值`, source, ownerId));
    }
  }
  return sampleInputs;
}

function decodeFieldType(rawType: unknown, name: string, issues: RecoveryIssue[], source: StorageSourceName, projectId: string): RuleField['type'] {
  if (rawType === 'number' || rawType === 'enum' || rawType === 'boolean') return rawType;
  const aliases: Record<string, RuleField['type']> = {
    integer: 'number', float: 'number', numeric: 'number', decimal: 'number',
    select: 'enum', option: 'enum', string: 'enum', text: 'enum',
    bool: 'boolean', flag: 'boolean',
  };
  if (typeof rawType === 'string' && aliases[rawType]) {
    issues.push(issue('field', 'warning', `字段“${name}”使用旧类型“${rawType}”，已迁移为“${aliases[rawType]}”`, source, projectId));
    return aliases[rawType];
  }
  issues.push(issue('field', 'warning', `字段“${name}”的类型无法识别，已暂按数值字段恢复`, source, projectId));
  return 'number';
}

function normalizeOperator(
  rawOperator: unknown,
  ownerName: string,
  source: StorageSourceName,
  projectId: string,
  ruleId: string,
  issues: RecoveryIssue[],
): ConditionGroup['operator'] {
  if (rawOperator === 'or') return 'or';
  if (rawOperator === 'and') return 'and';
  const normalized = String(rawOperator).toLowerCase();
  if (['or', '||'].includes(normalized)) {
    issues.push(issue('rule', 'warning', `规则“${ownerName}”使用旧组合操作符“${String(rawOperator)}”，已迁移为 or`, source, projectId, ruleId));
    return 'or';
  }
  if (rawOperator !== undefined) issues.push(issue('rule', 'warning', `规则“${ownerName}”的组合操作符无效，已暂按 and 处理`, source, projectId, ruleId));
  else issues.push(issue('rule', 'warning', `规则“${ownerName}”缺少组合操作符，已暂按 and 补全`, source, projectId, ruleId));
  return 'and';
}

function normalizePredicateOperator(
  rawOperator: unknown,
  ownerName: string,
  source: StorageSourceName,
  projectId: string,
  ruleId: string,
  issues: RecoveryIssue[],
): PredicateCondition['operator'] {
  type PredicateOperator = PredicateCondition['operator'];
  const aliases: Record<string, PredicateOperator> = {
    equal: 'eq', equals: 'eq', '=': 'eq',
    not_equal: 'notEq', ne: 'notEq', '!=': 'notEq',
    greater: 'gt', greater_than: 'gt', '>': 'gt',
    greater_or_equal: 'gte', gteq: 'gte', '>=': 'gte',
    less: 'lt', less_than: 'lt', '<': 'lt',
    less_or_equal: 'lte', lteq: 'lte', '<=': 'lte',
    true: 'isTrue', false: 'isFalse',
  };
  const valid: PredicateOperator[] = ['eq', 'notEq', 'gt', 'gte', 'lt', 'lte', 'between', 'isTrue', 'isFalse'];
  if (typeof rawOperator === 'string' && aliases[rawOperator]) {
    const migrated = aliases[rawOperator];
    issues.push(issue('rule', 'warning', `规则“${ownerName}”使用旧条件操作符“${rawOperator}”，已迁移为 ${migrated}`, source, projectId, ruleId));
    return migrated;
  }
  const normalized = typeof rawOperator === 'string' ? rawOperator : '';
  if ((valid as string[]).includes(normalized)) return normalized as PredicateOperator;
  issues.push(issue('rule', 'warning', `规则“${ownerName}”的条件操作符无法识别，已暂按 eq 处理`, source, projectId, ruleId));
  return 'eq';
}

function decodePredicateValue(
  rawValue: unknown,
  operator: string,
  fieldType: RuleField['type'] | undefined,
  ownerName: string,
  source: StorageSourceName,
  projectId: string,
  ruleId: string,
  issues: RecoveryIssue[],
): string | number | boolean | { min: number; max: number } {
  if (operator === 'between') {
    if (isRecord(rawValue) && typeof rawValue.min === 'number' && Number.isFinite(rawValue.min) && typeof rawValue.max === 'number' && Number.isFinite(rawValue.max)) {
      return { min: rawValue.min, max: rawValue.max };
    }
    issues.push(issue('rule', 'warning', `规则“${ownerName}”的区间值损坏，已暂设为 0 到 0，请修复`, source, projectId, ruleId));
    return { min: 0, max: 0 };
  }
  if (operator === 'isTrue' || operator === 'isFalse') {
    if (typeof rawValue === 'boolean') return rawValue;
    issues.push(issue('rule', 'warning', `规则“${ownerName}”缺少有效布尔值，已自动补全`, source, projectId, ruleId));
    return operator === 'isTrue';
  }
  if (typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean') return rawValue;
  issues.push(issue('rule', 'warning', `规则“${ownerName}”的条件值损坏，已留空并标记为待修复`, source, projectId, ruleId));
  return fieldType === 'number' ? 0 : fieldType === 'boolean' ? (operator === 'isFalse') : '';
}

function restoreId(
  rawId: unknown,
  prefix: string,
  index: number,
  usedIds: Set<string>,
  label: string,
  source: StorageSourceName,
  issues: RecoveryIssue[],
  projectId?: string,
): string {
  const base = typeof rawId === 'string' && rawId.trim() ? rawId : `recovered-${prefix}-${index + 1}`;
  if (base !== rawId) {
    issues.push(issue(prefix as RecoveryIssue['scope'], 'warning', `${label} ${labelOf(rawId, index + 1)} 缺少有效 ID，已补为“${base}”`, source, projectId, typeof rawId === 'string' ? rawId : undefined));
  }
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  if (id !== base) issues.push(issue(prefix as RecoveryIssue['scope'], 'warning', `${label} ID“${base}”重复，已将其中一条改为“${id}”`, source, projectId, base));
  usedIds.add(id);
  return id;
}

function defaultName(
  issues: RecoveryIssue[],
  scope: RecoveryIssue['scope'],
  id: string,
  message: string,
  fallback: string,
  source: StorageSourceName,
  projectId?: string,
): string {
  issues.push(issue(scope, 'warning', message, source, projectId, id));
  return fallback;
}

function labelOf(value: unknown, index: number): string {
  return typeof value === 'string' && value.trim() ? `“${value}”` : `#${index}`;
}

function issue(
  scope: RecoveryIssue['scope'],
  severity: RecoveryIssue['severity'],
  message: string,
  source?: StorageSourceName,
  projectId?: string,
  itemId?: string,
): RecoveryIssue {
  return { scope, severity, message, source, projectId, itemId };
}

function fatalSource(source: StorageSourceName, message: string, issues: RecoveryIssue[]): DecodedSource {
  return { source, fatal: true, fatalMessage: message, legacy: false, issues, issueCount: issues.length };
}

function sourceScore(candidate: DecodedSource): number {
  return (candidate.document?.projects.length ?? 0) * 1000 - candidate.issueCount;
}

function sourceRank(source: StorageSourceName): number {
  return source === 'indexedDb' ? 1 : 0;
}

function sourceLabel(source: StorageSourceName): string {
  return source === 'indexedDb' ? 'IndexedDB 本地数据库' : 'localStorage 本地缓存';
}

function documentsEqual(a: WorkspaceDocument, b: WorkspaceDocument): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
