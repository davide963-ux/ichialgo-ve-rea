import { Link } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';

export function NotFound() {
  return (
    <main className="page">
      <section className="panel">
        <EmptyState icon="plug" title="This page does not exist" action={<Link className="btn" to="/">Go to dashboard</Link>} />
      </section>
    </main>
  );
}
