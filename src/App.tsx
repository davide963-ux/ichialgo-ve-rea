import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Navbar } from './components/Navbar';
import { useMarketDataConnection } from './hooks/useMarketData';
import { Backtest } from './pages/Backtest';
import { CalculatorPage } from './pages/CalculatorPage';
import { Dashboard } from './pages/Dashboard';
import { EquityCurve } from './pages/EquityCurve';
import { NotFound } from './pages/NotFound';
import { PairPage } from './pages/PairPage';
import { useMarketStore } from './state/marketStore';

function Footer() {
  const provider = useMarketStore((s) => s.provider.label);
  return (
    <footer className="footer">
      <div className="footer-inner">
        <span>Ichialgo, phase 1: live market data. Strategy engine not connected.</span>
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
