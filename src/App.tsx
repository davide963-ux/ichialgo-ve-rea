import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Navbar } from './components/Navbar';
import { useMarketDataConnection } from './hooks/useMarketData';
import { CalculatorPage } from './pages/CalculatorPage';
import { Dashboard } from './pages/Dashboard';
import { NotFound } from './pages/NotFound';
import { PairPage } from './pages/PairPage';
import { useMarketStore } from './state/marketStore';

/**
 * Live market data and charts. No strategy.
 *
 * The signal engine, the 24/7 scanner and everything that read their output
 * were removed: measured against real market data the strategy had no edge,
 * and the honest move was to stop building on it rather than tune it again.
 * What is left is the part that was never in question — prices, charts and
 * the position-size calculator.
 */
function Footer() {
  const provider = useMarketStore((s) => s.provider.label);
  return (
    <footer className="footer">
      <div className="footer-inner">
        <span>Ichialgo: live Forex market data.</span>
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
          <Route path="/calculator" element={<CalculatorPage />} />
          {/* Routes that existed only to show strategy output. Redirected
              rather than 404'd, so old links and bookmarks still land. */}
          <Route path="/results" element={<Navigate to="/" replace />} />
          <Route path="/backtest" element={<Navigate to="/" replace />} />
          <Route path="/history" element={<Navigate to="/" replace />} />
          <Route path="/performance" element={<Navigate to="/" replace />} />
          <Route path="/equity" element={<Navigate to="/" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        <Footer />
      </div>
    </BrowserRouter>
  );
}
