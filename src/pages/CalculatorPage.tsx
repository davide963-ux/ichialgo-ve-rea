import { Calculator } from '../components/Calculator';

export function CalculatorPage() {
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Position size calculator</h1>
          <p>Size a trade from your account risk and stop distance. JPY pairs use a 0.01 pip.</p>
        </div>
      </div>
      <Calculator />
    </main>
  );
}
