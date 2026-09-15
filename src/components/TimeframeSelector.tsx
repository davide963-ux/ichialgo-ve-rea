import { TIMEFRAMES, type Timeframe } from '../config/timeframes';

interface Props {
  value: Timeframe;
  onChange: (tf: Timeframe) => void;
  label?: string;
}

export function TimeframeSelector({ value, onChange, label = 'Timeframe' }: Props) {
  return (
    <div className="tf" role="group" aria-label={label}>
      {TIMEFRAMES.map((tf) => (
        <button key={tf} type="button" aria-pressed={tf === value} onClick={() => onChange(tf)}>
          {tf}
        </button>
      ))}
    </div>
  );
}
