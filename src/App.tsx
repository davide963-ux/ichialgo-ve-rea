import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Navbar } from './components/Navbar';
import { useMarketDataConnection } from './hooks/useMarketData';
import { Backtest } from './pages/Backtest';
import { CalculatorPage } from './pages/CalculatorPage';
import { Dashboard } from './pages/Dashboard';
import { NotFound } from './pages/NotFound';
import { PairPage } from './pages/PairPage';
import { Results } from './pages/Results';
import { useMarketStore } from './state/marketStore';

/**
 * No strategy runs in the browser any more.
 *
 * There used to be a `StrategyRunner` here, driving an engine on every route
 * so the dashboard could show its own signals. That is exactly how the app
 * ended up with two sources of truth: a browser calculation shown to the user,
 * and a server-side scanner writing something different to the database.
 * Signals now come from the scanner alone, and the UI only ever reads them.
 */
function Footer() {
  const provider = useMarketStore((s) => s.provider.label);
  return (
    <footer className="footer">
      <div className="footer-inner">
        <span>Ichialgo: 24/7 forex scanner.</span>
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
        <Navbar />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/pair/:slug" element={<PairPage />} />
          <Route path="/results" element={<Results />} />
          <Route path="/backtest" element={<Backtest />} />
          <Route path="/calculator" element={<CalculatorPage />} />
          {/* History, Performance and Equity Curve were three pages answering
              one question with three different sets of the same numbers. They
              are now one page; the old links still land somewhere sensible. */}
          <Route path="/history" element={<Navigate to="/results" replace />} />
          <Route path="/performance" element={<Navigate to="/results" replace />} />
          <Route path="/equity" element={<Navigate to="/results" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        <Footer />
      </div>
    </BrowserRouter>
  );
}
