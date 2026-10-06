import { evaluateSample } from '../../domain/conditionEvaluator';
import type { RuleProject, SampleInput, ScalarValue } from '../../models/ruleModel';
import type { WorkspacePort } from '../../viewmodels/workspacePort';

export class SamplesViewModel {
  constructor(private readonly workspace: WorkspacePort) {}

  setValue(fieldId: string, value: ScalarValue | ''): void {
    const project = this.currentProject();
    if (!project) return;
    const sampleInputs: SampleInput = { ...project.sampleInputs, [fieldId]: value };
    this.workspace.commitProject({ ...project, sampleInputs }, '样例已更新', { recheck: false });
  }

  evaluate(): void {
    const project = this.currentProject();
    if (!project) return;
    const evaluation = evaluateSample(project, project.sampleInputs);
    this.workspace.updateView({ sampleEvaluation: evaluation, notice: evaluation.valid ? '样例求值完成' : '样例缺少或包含无效输入' });
  }

  private currentProject(): RuleProject | null {
    return this.workspace.getSnapshot().project;
  }
}
