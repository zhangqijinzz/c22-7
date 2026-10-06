import type { RuleWorkspaceViewModel } from '../../viewmodels/workspaceViewModel';

export class InspectionViewModel {
  constructor(private readonly workspace: RuleWorkspaceViewModel) {}

  check(): Promise<void> {
    return this.workspace.runCheck();
  }

  cancel(): void {
    this.workspace.cancelCheck();
  }

  saveVersion(): void {
    this.workspace.saveVersion();
  }

  freeze(): void {
    this.workspace.freezeCurrent();
  }

  continueFrom(versionId: string): void {
    this.workspace.restoreVersion(versionId);
  }

  copyToProject(versionId: string): void {
    this.workspace.copyVersionToProject(versionId);
  }
}
