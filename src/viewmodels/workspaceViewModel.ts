import { evaluateSample } from '../domain/conditionEvaluator';
import { ruleDomain } from '../domain/ruleDomain';
import type {
  ModuleId,
  RuleAnalysis,
  RuleProject,
  SampleEvaluation,
  WorkspaceDocument,
} from '../models/ruleModel';
import { cloneData, createBlankProject, createDemoWorkspace, createVersionSnapshot, makeId } from '../models/projectFactory';
import { RuleRepository } from '../repositories/ruleRepository';
import { ProjectStorageService } from '../services/projectStorageService';
import { RuleCheckService, type CheckOperation } from '../services/ruleCheckService';
import type { WorkspacePort } from './workspacePort';

export type WorkspacePhase = 'loading' | 'editing' | 'validating' | 'checking' | 'ready' | 'error';
export type CheckStatus = 'idle' | 'scheduled' | 'checking' | 'success' | 'error' | 'cancelled';

export interface WorkspaceState {
  phase: WorkspacePhase;
  persistence: 'idle' | 'saving' | 'saved' | 'error';
  workspace: WorkspaceDocument | null;
  project: RuleProject | null;
  activeModule: ModuleId;
  checkStatus: CheckStatus;
  analysis: RuleAnalysis | null;
  validationIssues: ReturnType<typeof ruleDomain.validateProject>;
  sampleEvaluation: SampleEvaluation | null;
  selectedRuleId?: string;
  notice: string;
  saveError?: string;
}

type Listener = () => void;
type WorkspaceRepository = Pick<RuleRepository, 'load' | 'save'>;
type Checker = Pick<RuleCheckService, 'run'>;

export class RuleWorkspaceViewModel implements WorkspacePort {
  private state: WorkspaceState = {
    phase: 'loading', persistence: 'idle', workspace: null, project: null,
    activeModule: 'inspection', checkStatus: 'idle', analysis: null,
    validationIssues: [], sampleEvaluation: null, notice: '正在恢复本地规则项目…',
  };
  private readonly listeners = new Set<Listener>();
  private startPromise?: Promise<void>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private checkTimer?: ReturnType<typeof setTimeout>;
  private checkOperation?: CheckOperation;
  private checkRevision = 0;
  private saveRevision = 0;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: WorkspaceRepository = new RuleRepository(new ProjectStorageService()),
    private readonly checker: Checker = new RuleCheckService(),
  ) {}

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): WorkspaceState => this.state;

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.initialize();
    return this.startPromise;
  }

  async flushSave(): Promise<void> {
    if (this.saveTimer && this.state.workspace) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      this.enqueueSave(this.state.workspace, this.saveRevision);
    }
    await this.writeQueue;
  }

  dispose(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkOperation?.cancel();
    this.checkOperation = undefined;
  }

  commitProject(project: RuleProject, notice = '项目已更新', options: { recheck?: boolean } = {}): boolean {
    const current = this.state.project;
    if (!current || current.frozenVersionId) {
      this.updateView({ notice: '当前版本已冻结。请先从版本记录中复制一份继续编辑。' });
      return false;
    }
    this.replaceProject({ ...project, updatedAt: Date.now() }, notice, options.recheck !== false);
    return true;
  }

  updateView(patch: Partial<WorkspaceState>): void {
    this.publish({ ...this.state, ...patch });
  }

  navigate(module: ModuleId): void {
    this.updateView({ activeModule: module, notice: '' });
  }

  selectRule(ruleId?: string): void {
    this.updateView({ selectedRuleId: ruleId });
  }

  renameProject(title: string): void {
    const project = this.state.project;
    if (project) this.commitProject({ ...project, title }, '项目名称已更新', { recheck: false });
  }

  async runCheck(): Promise<void> {
    const project = this.state.project;
    if (!project) return;
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = undefined;
    const issues = ruleDomain.validateProject(project);
    if (issues.length) {
      this.publish({ ...this.state, phase: 'validating', checkStatus: 'error', validationIssues: issues, notice: issues[0].message });
      return;
    }
    this.checkOperation?.cancel();
    const revision = ++this.checkRevision;
    this.publish({ ...this.state, phase: 'checking', checkStatus: 'checking', notice: '正在工作线程中枚举输入空间…' });
    try {
      const operation = this.checker.run(project);
      this.checkOperation = operation;
      const analysis = await operation.promise;
      if (revision !== this.checkRevision) return;
      this.checkOperation = undefined;
      this.publish({ ...this.state, phase: 'ready', checkStatus: 'success', analysis, notice: `检查完成：已分析 ${analysis.checkedCases.toLocaleString('zh-CN')} 个逻辑分区` });
    } catch (error) {
      if (revision !== this.checkRevision) return;
      this.checkOperation = undefined;
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.publish({ ...this.state, phase: 'editing', checkStatus: 'cancelled', notice: '检查已取消' });
      } else {
        const message = error instanceof Error ? error.message : '规则检查失败';
        this.publish({ ...this.state, phase: 'error', checkStatus: 'error', notice: message });
      }
    }
  }

  cancelCheck(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = undefined;
    this.checkRevision += 1;
    this.checkOperation?.cancel();
    this.checkOperation = undefined;
    if (this.state.checkStatus === 'checking' || this.state.checkStatus === 'scheduled') {
      this.publish({ ...this.state, phase: 'editing', checkStatus: 'cancelled', notice: '检查已取消' });
    }
  }

  createProject(): void {
    const workspace = this.state.workspace;
    if (!workspace) return;
    const project = createBlankProject(workspace.projects.length + 1);
    const next: WorkspaceDocument = { ...workspace, projects: [...workspace.projects, project], activeProjectId: project.id };
    this.publish({ ...this.state, workspace: next, project, phase: 'validating', activeModule: 'fields', analysis: null, checkStatus: 'idle', validationIssues: ruleDomain.validateProject(project), sampleEvaluation: evaluateSample(project, project.sampleInputs), selectedRuleId: undefined, notice: '空项目已创建。先定义字段，再添加规则。' });
    this.scheduleSave(next);
  }

  switchProject(projectId: string): void {
    const workspace = this.state.workspace;
    const project = workspace?.projects.find((candidate) => candidate.id === projectId);
    if (!workspace || !project || workspace.activeProjectId === projectId) return;
    this.cancelCheck();
    const next = { ...workspace, activeProjectId: projectId };
    const issues = ruleDomain.validateProject(project);
    this.publish({ ...this.state, workspace: next, project, phase: issues.length ? 'validating' : 'editing', activeModule: 'inspection', checkStatus: issues.length ? 'idle' : 'scheduled', analysis: null, validationIssues: issues, sampleEvaluation: evaluateSample(project, project.sampleInputs), selectedRuleId: project.rules[0]?.id, notice: `已切换到“${project.title}”` });
    this.scheduleSave(next);
    if (!issues.length) this.scheduleCheck(80);
  }

  saveVersion(): void {
    const project = this.state.project;
    if (!project) return;
    const version = createVersionSnapshot(project, `版本 ${project.versions.length + 1}`, false);
    this.replaceProject({ ...project, versions: [version, ...project.versions] }, `已保存${version.name}`, false);
  }

  freezeCurrent(): void {
    const project = this.state.project;
    if (!project || project.frozenVersionId) return;
    const version = createVersionSnapshot(project, `冻结版本 ${project.versions.length + 1}`, true);
    this.replaceProject({ ...project, versions: [version, ...project.versions], frozenVersionId: version.id }, `已冻结${version.name}`, false, true);
  }

  restoreVersion(versionId: string): void {
    const project = this.state.project;
    const version = project?.versions.find((candidate) => candidate.id === versionId);
    if (!project || !version) return;
    this.replaceProject({ ...project, fields: cloneData(version.fields), rules: cloneData(version.rules), sampleInputs: cloneData(version.sampleInputs), frozenVersionId: undefined }, `已从“${version.name}”建立可编辑版本`, true, true);
    this.navigate('rules');
  }

  copyVersionToProject(versionId: string): void {
    const workspace = this.state.workspace;
    const source = this.state.project;
    const version = source?.versions.find((candidate) => candidate.id === versionId);
    if (!workspace || !source || !version) return;
    const project: RuleProject = {
      id: makeId('project'), title: `${source.title} · ${version.name}副本`,
      fields: cloneData(version.fields), rules: cloneData(version.rules), sampleInputs: cloneData(version.sampleInputs),
      versions: [], updatedAt: Date.now(),
    };
    const next = { ...workspace, projects: [...workspace.projects, project], activeProjectId: project.id };
    const issues = ruleDomain.validateProject(project);
    this.publish({ ...this.state, workspace: next, project, phase: issues.length ? 'validating' : 'editing', activeModule: 'rules', checkStatus: issues.length ? 'idle' : 'scheduled', analysis: null, validationIssues: issues, sampleEvaluation: evaluateSample(project, project.sampleInputs), selectedRuleId: project.rules[0]?.id, notice: `已复制版本到项目“${project.title}”` });
    this.scheduleSave(next);
    if (!issues.length) this.scheduleCheck(80);
  }

  private async initialize(): Promise<void> {
    this.publish({ ...this.state, phase: 'loading', notice: '正在恢复本地规则项目…' });
    try {
      const saved = await this.repository.load();
      const workspace = saved ?? createDemoWorkspace();
      const project = workspace.projects.find((candidate) => candidate.id === workspace.activeProjectId) ?? workspace.projects[0];
      const issues = ruleDomain.validateProject(project);
      this.publish({ ...this.state, workspace, project, phase: issues.length ? 'validating' : 'editing', persistence: saved ? 'saved' : 'saving', activeModule: 'inspection', checkStatus: issues.length ? 'idle' : 'scheduled', validationIssues: issues, analysis: null, sampleEvaluation: evaluateSample(project, project.sampleInputs), selectedRuleId: project.rules[0]?.id, notice: saved ? '已从本地恢复最近项目' : '已载入演示项目，可直接修改并检查规则' });
      if (saved) this.scheduleCheck(40);
      else {
        this.scheduleSave(workspace);
        if (!issues.length) this.scheduleCheck(40);
      }
    } catch (error) {
      this.publish({ ...this.state, phase: 'error', notice: error instanceof Error ? error.message : '项目初始化失败' });
    }
  }

  private replaceProject(project: RuleProject, notice: string, recheck: boolean, allowFrozen = false): void {
    const workspace = this.state.workspace;
    if (!workspace) return;
    if (this.state.project?.frozenVersionId && !allowFrozen) {
      this.updateView({ notice: '当前版本已冻结。请先从版本记录中复制一份继续编辑。' });
      return;
    }
    const updated = { ...project, updatedAt: Date.now() };
    const next = { ...workspace, projects: workspace.projects.map((candidate) => candidate.id === updated.id ? updated : candidate) };
    const issues = ruleDomain.validateProject(updated);
    this.publish({
      ...this.state, workspace: next, project: updated,
      phase: issues.length ? 'validating' : 'editing', validationIssues: issues,
      checkStatus: issues.length ? 'idle' : recheck ? 'scheduled' : this.state.checkStatus,
      analysis: recheck ? null : this.state.analysis,
      sampleEvaluation: evaluateSample(updated, updated.sampleInputs),
      selectedRuleId: updated.rules.some((rule) => rule.id === this.state.selectedRuleId) ? this.state.selectedRuleId : updated.rules[0]?.id,
      notice,
    });
    this.scheduleSave(next);
    if (recheck && !issues.length) this.scheduleCheck(180);
    else if (issues.length) this.cancelPendingCheck();
  }

  private scheduleCheck(delay: number): void {
    this.cancelPendingCheck();
    this.updateView({ checkStatus: 'scheduled' });
    this.checkTimer = setTimeout(() => {
      this.checkTimer = undefined;
      void this.runCheck();
    }, delay);
  }

  private cancelPendingCheck(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = undefined;
    if (this.checkOperation) {
      this.checkRevision += 1;
      this.checkOperation.cancel();
      this.checkOperation = undefined;
    }
  }

  private scheduleSave(workspace: WorkspaceDocument): void {
    const revision = ++this.saveRevision;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.publish({ ...this.state, persistence: 'saving', saveError: undefined });
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.enqueueSave(workspace, revision);
    }, 220);
  }

  private enqueueSave(workspace: WorkspaceDocument, revision: number): void {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(() => this.repository.save(workspace)).then(() => {
      if (revision === this.saveRevision) this.publish({ ...this.state, persistence: 'saved', saveError: undefined });
    }).catch((error: unknown) => {
      if (revision === this.saveRevision) this.publish({ ...this.state, persistence: 'error', saveError: error instanceof Error ? error.message : '保存失败' });
    });
  }

  private publish(state: WorkspaceState): void {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}
