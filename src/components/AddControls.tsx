import { CONDITIONS, CONDITION_LABEL, FINISH_LABEL, LANGS, type Condition, type Finish } from '../types';

export interface AddState {
  finish: Finish;
  condition: Condition;
  lang: string;
  quantity: number;
}

const ALL_FINISHES: Finish[] = ['nonfoil', 'foil', 'etched'];
const QUICK_LANGS = ['en', 'es', 'pt'];

export function AddControls({
  state,
  onChange,
  finishes,
}: {
  state: AddState;
  onChange: (s: AddState) => void;
  finishes: Finish[];
}) {
  const quick = QUICK_LANGS.includes(state.lang) ? QUICK_LANGS : [...QUICK_LANGS, state.lang];
  return (
    <div className="scan-opts">
      <div className="chips">
        {ALL_FINISHES.filter((f) => finishes.includes(f) || f === state.finish).map((f) => (
          <button
            key={f}
            type="button"
            className={`chip ${state.finish === f ? 'on' : ''}`}
            disabled={!finishes.includes(f)}
            onClick={() => onChange({ ...state, finish: f })}
          >
            {FINISH_LABEL[f]}
          </button>
        ))}
        <span style={{ width: 4 }} />
        {quick.map((code) => (
          <button
            key={code}
            type="button"
            className={`chip ${state.lang === code ? 'on teal' : ''}`}
            onClick={() => onChange({ ...state, lang: code })}
          >
            {code.toUpperCase()}
          </button>
        ))}
        <select
          className="chip"
          value=""
          onChange={(e) => {
            if (e.target.value) onChange({ ...state, lang: e.target.value });
          }}
          aria-label="Otro idioma"
        >
          <option value="">Otro…</option>
          {LANGS.filter((l) => !quick.includes(l.code)).map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <div className="chips">
        {CONDITIONS.map((c) => (
          <button
            key={c}
            type="button"
            className={`chip ${state.condition === c ? 'on' : ''}`}
            title={CONDITION_LABEL[c]}
            onClick={() => onChange({ ...state, condition: c })}
          >
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Stepper({
  value,
  onChange,
  min = 1,
  max = 999,
  small = false,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  small?: boolean;
}) {
  return (
    <div className={`stepper ${small ? 'sm' : ''}`}>
      <button type="button" aria-label="Menos" onClick={() => onChange(Math.max(min, value - 1))}>
        −
      </button>
      <span>{value}</span>
      <button type="button" aria-label="Más" onClick={() => onChange(Math.min(max, value + 1))}>
        +
      </button>
    </div>
  );
}
