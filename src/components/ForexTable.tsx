import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { pairToSlug } from '../config/pairs';
import type { Timeframe } from '../config/timeframes';
import { useMarketStore } from '../state/marketStore';
import { ForexRow } from './ForexRow';

interface Props {
  timeframe: Timeframe;
}

export function ForexTable({ timeframe }: Props) {
  const symbols = useMarketStore((s) => s.symbols);
  const caps = useMarketStore((s) => s.provider.capabilities);
  const provider = useMarketStore((s) => s.provider.label);
  const navigate = useNavigate();

  const open = useCallback(
    (symbol: string) => navigate(`/pair/${pairToSlug(symbol)}?tf=${timeframe}`),
    [navigate, timeframe],
  );

  const noBidAsk = caps.bidAsk ? undefined : `${provider} does not provide bid/ask on this plan`;
  const changeTip =
    caps.changeBasis === 'rolling-24h'
      ? 'Change vs. price 24 hours ago'
      : `Change vs. previous daily close (${provider})`;

  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">Live Forex prices. Select a row to open the chart.</caption>
        <thead>
          <tr>
            <th scope="col">PAIR</th>
            <th scope="col">PRICE</th>
            <th scope="col">{noBidAsk ? <abbr title={noBidAsk}>BID</abbr> : 'BID'}</th>
            <th scope="col">{noBidAsk ? <abbr title={noBidAsk}>ASK</abbr> : 'ASK'}</th>
            <th scope="col"><abbr title="Ask − bid, in pips">SPREAD</abbr></th>
            <th scope="col"><abbr title={changeTip}>24H CHANGE</abbr></th>
            <th scope="col">TIMEFRAME</th>
            <th scope="col"><abbr title="Provider timestamp of the latest price (local time)">LAST UPDATE</abbr></th>
          </tr>
        </thead>
        <tbody>
          {symbols.map((s) => (
            <ForexRow key={s} symbol={s} timeframe={timeframe} onOpen={open} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
