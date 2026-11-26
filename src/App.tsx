import { BrowserRouter, Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { Navbar } from './components/Navbar';
import { DEFAULT_TIMEFRAME, isTimeframe } from './config/timeframes';
import { useMarketDataConnection } from './hooks/useMarketData';
import { useStrategyEngine } from './hooks/useSignals';
import { CalculatorPage } from './pages/CalculatorPage';
import { Backtest } from './pages/Backtest';
import { Dashboard } from './pages/Dashboard';
import { History } from './pages/History';
import { NotFound } from './pages/NotFound';
import { PairPage } from './pages/PairPage';
import { useMarketStore } from './state/marketStore';

/**
 * Live market data, charts, and the Ichimoku system.
 *
 * The strategy runs in the BROWSER, off the candles the charts already hold:
 * a signal is a pure function of the bars on screen, so what the page shows
 * and what the engine decided can never disagree.
 *
 * /history is the one exception, and deliberately a READ-ONLY one. A browser
 * can only record what happens while a tab is open, which would make the
 * history a log of when somebody visited the site rather than of what the
 * market did. So a server-side scanner writes it on a schedule and this app
 * only reads it — and the scanner runs the SAME compiled strategy (see
 * src/services/strategy/serverEntry.ts), so the two still cannot disagree.
 */

/**
 * Keeps the strategy engine pointed at the timeframe in the URL, for every
 * route. Lives inside the router because that is where `?tf=` is readable.
 */
function StrategyRunner() {
  const [params] = useSearchParams();
  const tf = params.get('tf');
  useStrategyEngine(isTimeframe(tf) ? tf : DEFAULT_TIMEFRAME);
  return null;
}

function Footer() {
  const provider = useMarketStore((s) => s.provider.label);
  return (
    <footer className="footer">
      <div className="footer-inner">
        <span>Ichialgo: live Forex market data + the Ichimoku system.</span>
        <span>Data: {provider}. Charts by TradingView Lightweight Charts.</span>
      </div>
    </footer>
  );
}

export default function App() {
  useMarketDataConnection();
  return (
    <BrowserRouter>
      <div className="app">
        <StrategyRunner />
        <Navbar />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/pair/:slug" element={<PairPage />} />
          <Route path="/backtest" element={<Backtest />} />
          <Route path="/history" element={<History />} />
          <Route path="/calculator" element={<CalculatorPage />} />
          {/* Routes that existed only to show strategy output. Redirected
              rather than 404'd, so old links and bookmarks still land.
              /history is no longer among them — it is a real page again. */}
          <Route path="/results" element={<Navigate to="/history" replace />} />
          <Route path="/performance" element={<Navigate to="/history" replace />} />
          <Route path="/equity" element={<Navigate to="/" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        <Footer />
      </div>
    </BrowserRouter>
  );
}
