import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { EmptyState } from '../components/EmptyState';
import { PairDetails } from '../components/PairDetails';
import { slugToPair } from '../config/pairs';
import { DEFAULT_TIMEFRAME, isTimeframe, type Timeframe } from '../config/timeframes';

export function PairPage() {
  const { slug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const symbol = slugToPair(slug);
  const tfParam = params.get('tf');
  const timeframe: Timeframe = isTimeframe(tfParam) ? tfParam : DEFAULT_TIMEFRAME;

  if (!symbol) {
    return (
      <main className="page">
        <section className="panel">
          <EmptyState icon="plug" title={`${slug.toUpperCase()} is not in the pair list`} action={<Link className="btn" to="/">Back to scanner</Link>}>
            Add it to <code>src/config/pairs.ts</code> to track it.
          </EmptyState>
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      <ConnectionBanner />
      <PairDetails symbol={symbol} timeframe={timeframe} onTimeframeChange={(tf) => setParams({ tf }, { replace: true })} />
    </main>
  );
}
