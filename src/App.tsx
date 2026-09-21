import { BrowserRouter, Route, Routes, useSearchParams } from 'react-router-dom';
import { Navbar } from './components/Navbar';
import { DEFAULT_TIMEFRAME, isTimeframe } from './config/timeframes';
import { useMarketDataConnection } from './hooks/useMarketData';
import { useStrategyEngine } from './hooks/useSignals';
import { Backtest } from './pages/Backtest';
import { CalculatorPage } from './pages/CalculatorPage';
import { Dashboard } from './pages/Dashboard';
import { History } from './pages/History';
import { PerformancePage } from './pages/Performance';
import { EquityCurve } from './pages/EquityCurve';
import { NotFound } from './pages/NotFound';
import { PairPage } from './pages/PairPage';
import { useMarketStore } from './state/marketStore';

/**
 * Keeps the strategy engine pointed at the timeframe in the URL, for every
 * route. Lives inside the router because that is where `?tf=` is readable.
 */
function StrategyRunner() {
  const [params] = useSearchParams();
  const tf = params.get('tf');
  useStrategyEngine(isTimeframe(tf) ? tf : DEFAULT_TIMEFRAME);
  // Nothing is persisted from here: signals are produced by the server-side
  // scanner, so what the browser computes is a live view, not the record.
  return null;
}

function Footer() {
  const provider = useMarketStore((s) => s.provider.label);
  return (
    <footer className="footer">
      <div className="footer-inner">
        <span>Ichialgo: 24/7 Ichimoku + EMA50 confluence scanner.</span>
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
          <Route path="/history" element={<History />} />
          <Route path="/performance" element={<PerformancePage />} />
          <Route path="/equity" element={<EquityCurve />} />
          <Route path="/backtest" element={<Backtest />} />
          <Route path="/calculator" element={<CalculatorPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        <Footer />
      </div>
    </BrowserRouter>
  );
}
