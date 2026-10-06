import { validateProject } from './fieldValidation';
import { analyzeRules } from './ruleAnalysis';
import type { DomainChecker } from '../models/ruleModel';

export const ruleDomain: DomainChecker = {
  validateProject,
  analyze: analyzeRules,
};
