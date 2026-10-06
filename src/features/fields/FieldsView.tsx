import type { FieldType, RuleField } from '../../models/ruleModel';
import type { WorkspaceState } from '../../viewmodels/workspaceViewModel';
import type { FieldsViewModel } from './fieldsViewModel';

interface FieldsViewProps {
  state: WorkspaceState;
  viewModel: FieldsViewModel;
}

const fieldTypes: { type: FieldType; label: string; icon: string }[] = [
  { type: 'number', label: '数值', icon: '↕' },
  { type: 'enum', label: '枚举', icon: '☷' },
  { type: 'boolean', label: '布尔', icon: '◉' },
];

export function FieldsView({ state, viewModel }: FieldsViewProps) {
  const fields = state.project?.fields ?? [];
  return (
    <section className="module-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">模块 01 / 输入空间</span>
          <h1>字段定义</h1>
          <p>定义规则可读取的输入，以及每个字段允许出现的值。</p>
        </div>
        <span className="count-chip">{fields.length} 个字段</span>
      </div>

      <div className="field-toolbar card-surface">
        <div><strong>添加输入字段</strong><span>字段类型创建后固定，合法范围可以随时调整。</span></div>
        <div className="button-row">
          {fieldTypes.map(({ type, label, icon }) => <button className="button button-subtle" key={type} onClick={() => viewModel.addField(type)}><span className="button-icon">{icon}</span>{label}</button>)}
        </div>
      </div>

      {fields.length === 0 ? (
        <div className="empty-card card-surface">
          <div className="empty-icon">＋</div><h2>从第一个字段开始</h2>
          <p>数值字段适合金额或分数，枚举字段适合等级，布尔字段表示是或否。</p>
        </div>
      ) : (
        <div className="field-grid">
          {fields.map((field, index) => <FieldCard key={field.id} field={field} index={index} referenced={viewModel.isReferenced(field.id)} onUpdate={(updates) => viewModel.updateField(field.id, updates)} onRemove={() => viewModel.removeField(field.id)} />)}
        </div>
      )}

      {state.validationIssues.filter((issue) => issue.fieldId).map((issue) => <div className="inline-issue" key={`${issue.code}-${issue.fieldId}`}>! {issue.message}</div>)}
    </section>
  );
}

interface FieldCardProps {
  field: RuleField;
  index: number;
  referenced: boolean;
  onUpdate: (updates: Partial<RuleField>) => void;
  onRemove: () => void;
}

function FieldCard({ field, index, referenced, onUpdate, onRemove }: FieldCardProps) {
  return (
    <article className="field-card card-surface">
      <header className="card-heading">
        <div className="field-index">{String(index + 1).padStart(2, '0')}</div>
        <div className="field-heading-copy"><span className="type-tag">{field.type === 'number' ? 'NUMBER' : field.type === 'enum' ? 'ENUM' : 'BOOLEAN'}</span><strong>{field.name || '未命名字段'}</strong></div>
        <button className="icon-button danger-hover" aria-label={`删除${field.name}`} title="删除字段" onClick={onRemove}>×</button>
      </header>
      <label className="input-label">字段名称<input value={field.name} onChange={(event) => onUpdate({ name: event.target.value })} placeholder="例如：订单金额" /></label>
      {field.type === 'number' && <div className="range-fields">
        <label className="input-label">最小值<input type="number" value={field.min ?? ''} onChange={(event) => onUpdate({ min: event.target.value === '' ? undefined : Number(event.target.value) })} /></label>
        <span className="range-dash">—</span>
        <label className="input-label">最大值<input type="number" value={field.max ?? ''} onChange={(event) => onUpdate({ max: event.target.value === '' ? undefined : Number(event.target.value) })} /></label>
      </div>}
      {field.type === 'enum' && <label className="input-label">可选值 <span className="muted-note">以逗号分隔</span><textarea rows={3} value={(field.enumValues ?? []).join(', ')} onChange={(event) => onUpdate({ enumValues: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} placeholder="普通会员, 银卡会员, 金卡会员" /></label>}
      {field.type === 'boolean' && <div className="boolean-definition"><span className="toggle-preview">是 / 否</span><span>输入值只能为真或假</span></div>}
      <footer className="field-card-footer"><span className={referenced ? 'reference-state is-used' : 'reference-state'}><i />{referenced ? '已被规则引用' : '尚未被引用'}</span><span>{field.type === 'number' ? '闭区间范围' : field.type === 'enum' ? `${field.enumValues?.length ?? 0} 个选项` : '二元输入'}</span></footer>
    </article>
  );
}
