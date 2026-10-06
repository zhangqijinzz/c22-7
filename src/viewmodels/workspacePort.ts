import type { ModuleId, RuleProject } from '../models/ruleModel';
import type { WorkspaceState } from './workspaceViewModel';

export interface WorkspacePort {
  getSnapshot(): WorkspaceState;
  commitProject(project: RuleProject, notice?: string, options?: { recheck?: boolean }): boolean;
  updateView(patch: Partial<WorkspaceState>): void;
  navigate(module: ModuleId): void;
  selectRule(ruleId?: string): void;
}
