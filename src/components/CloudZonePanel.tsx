import { formatNumber, formatPrice } from '../lib/format';
import type { CloudZone } from '../services/strategy';

/**
 * OANDA's fourth approach, read off the chart: "Identifying future support
 * and resistance zones".
 *
 * Their rule, quoted: the Kumo "act[s] as a potential future support zone if
 * price is above the Cloud, and as a potential future resistance zone if
 * price is below the Cloud." The zone is the cloud being drawn 26 bars ahead,
 * which is knowable today — that forward visibility is the thing Ichimoku has
 * and a moving average does not.
 *
 * It is NOT a signal and deliberately produces none. The article presents it
 * as a way of reading the chart, with no trigger and no direction, so turning
 * it into an entry would be putting a number on something nobody claimed.
 */
export function CloudZonePanel({
  symbol,
  zone,
  rangePips,
  strength,
}: {
  symbol: string;
  zone: CloudZone | null;
  rangePips: number | null;
  strength: (thicknessPips: number, rangePips: number) => 'thick' | 'thin';
}) {
  const thickness = zone && rangePips !== null ? strength(zone.thicknessPips, rangePips) : null;

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2 className="panel-title">Future support &amp; resistance</h2>
          <span className="panel-sub">
            The Kumo 26 bars ahead, already determined. Support while price is above the cloud, resistance while it
            is below — and nothing at all while price is inside it.
          </span>
        </div>
        {thickness && (
          <span className={`tag${thickness === 'thick' ? ' pos' : ''}`} title="A thick cloud is stronger support or resistance; a thin one is weaker">
            {thickness.toUpperCase()}
          </span>
        )}
      </div>

      {zone === null ? (
        <p className="panel-body muted">
          Price is inside the Kumo, so the cloud ahead is neither support nor resistance — it is the range price is
          already in.
        </p>
      ) : (
        <dl className="quote-grid panel-body">
          <div>
            <dt>Zone</dt>
            <dd className={zone.kind === 'support' ? 'pos' : 'neg'}>{zone.kind.toUpperCase()}</dd>
          </div>
          <div>
            <dt>Near edge</dt>
            <dd className="num">{formatPrice(symbol, zone.near)}</dd>
          </div>
          <div>
            <dt>Far edge</dt>
            <dd className="num">{formatPrice(symbol, zone.far)}</dd>
          </div>
          <div>
            <dt>Thickness</dt>
            <dd className="num">{formatNumber(zone.thicknessPips, 1)} pips</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
