import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { KumoMark } from './KumoMark';
import { MarketStatus } from './MarketStatus';

const LINKS = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/equity', label: 'Equity Curve' },
  { to: '/backtest', label: 'Backtest' },
  { to: '/calculator', label: 'Calculator' },
];

export function Navbar() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);

  return (
    <header className="nav">
      <div className="nav-inner">
        <Link to="/" className="brand" aria-label="Ichialgo home">
          <KumoMark />
          <span className="brand-word">
            ICHI<b>ALGO</b>
          </span>
        </Link>

        <nav id="main-nav" className={`nav-links${open ? ' open' : ''}`} aria-label="Main">
          {LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              className={({ isActive }) =>
                `nav-link${isActive || (l.to === '/' && pathname.startsWith('/pair/')) ? ' active' : ''}`
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>

        <div className="nav-right">
          <MarketStatus pill />
          <button
            className="nav-toggle"
            aria-label="Toggle navigation"
            aria-expanded={open}
            aria-controls="main-nav"
            onClick={() => setOpen((o) => !o)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}
