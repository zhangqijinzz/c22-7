import type {
  BusinessRule,
  ConditionGroup,
  PredicateCondition,
  RuleCondition,
  RuleField,
  RuleProject,
  SampleEvaluation,
  SampleInput,
} from '../models/ruleModel';

export function matchesCondition(condition: RuleCondition, values: SampleInput): boolean {
  if (condition.kind === 'group') {
    const checks = condition.conditions.map((child) => matchesCondition(child, values));
    return condition.operator === 'and' ? checks.every(Boolean) : checks.some(Boolean);
  }
  const actual = values[condition.fieldId];
  if (condition.operator === 'isTrue') return actual === true;
  if (condition.operator === 'isFalse') return actual === false;
  if (condition.operator === 'between') {
    return typeof actual === 'number' && actual >= condition.value.min && actual <= condition.value.max;
  }
  if (typeof condition.value === 'number') {
    if (typeof actual !== 'number') return false;
    switch (condition.operator) {
      case 'eq': return actual === condition.value;
      case 'gt': return actual > condition.value;
      case 'gte': return actual >= condition.value;
      case 'lt': return actual < condition.value;
      case 'lte': return actual <= condition.value;
      default: return false;
    }
  }
  if (typeof actual !== 'string') return false;
  return condition.operator === 'eq' ? actual === condition.value : actual !== condition.value;
}

export function matchesRule(rule: BusinessRule, values: SampleInput): boolean {
  return matchesCondition(rule.conditions, values);
}

export function evaluateSample(project: RuleProject, values: SampleInput): SampleEvaluation {
  const errors: string[] = [];
  for (const field of project.fields) {
    const value = values[field.id];
    if (value === undefined || value === '') {
      errors.push(`请填写“${field.name}”`);
      continue;
    }
    if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`“${field.name}”必须是有效数值`);
      else if (value < (field.min ?? -Infinity) || value > (field.max ?? Infinity)) errors.push(`“${field.name}”需在 ${field.min} 到 ${field.max} 之间`);
    }
    if (field.type === 'enum' && (typeof value !== 'string' || !(field.enumValues ?? []).includes(value))) {
      errors.push(`“${field.name}”需要选择一个合法选项`);
    }
    if (field.type === 'boolean' && typeof value !== 'boolean') errors.push(`“${field.name}”需要选择是或否`);
  }
  if (errors.length) return { valid: false, errors, matchedRules: [] };
  const matchedRules = project.rules
    .filter((rule) => matchesRule(rule, values))
    .sort((a, b) => b.priority - a.priority || project.rules.indexOf(a) - project.rules.indexOf(b));
  return { valid: true, errors: [], matchedRules, winner: matchedRules[0] };
}

export function defaultSample(fields: RuleField[]): SampleInput {
  return Object.fromEntries(fields.map((field) => [
    field.id,
    field.type === 'number' ? field.min ?? 0 : field.type === 'enum' ? field.enumValues?.[0] ?? '' : false,
  ]));
}

export function group(operator: ConditionGroup['operator'], ...conditions: RuleCondition[]): ConditionGroup {
  return { kind: 'group', operator, conditions };
}

export function predicate(condition: PredicateCondition): PredicateCondition {
  return condition;
}
