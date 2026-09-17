import { BrowserRouter, Route, Routes, useSearchParams } from 'react-router-dom';
import { Navbar } from './components/Navbar';
import { DEFAULT_TIMEFRAME, isTimeframe } from './config/timeframes';
import { useMarketDataConnection } from './hooks/useMarketData';
import { useStrategyEngine } from './hooks/useSignals';
import { Backtest } from './pages/Backtest';
import { CalculatorPage } from './pages/CalculatorPage';
import { Dashboard } from './pages/Dashboard';
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
  return null;
}

function Footer() {
  const provider = useMarketStore((s) => s.provider.label);
  return (
    <footer className="footer">
      <div className="footer-inner">
        <span>Ichialgo: live market data + EMA50 touch strategy.</span>
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
