import type { FC } from 'react';
import { PullListPage } from './pages/PullListPage.tsx';
import { PullPage } from './pages/PullPage.tsx';
import { ResultsPage } from './pages/ResultsPage.tsx';
import { Link } from './components/Link.tsx';
import { usePathname } from './router.ts';

// /pr/12, /pr/12/files and /pr/12/files/<topic>.
// /results/<commit> and /results/<commit>/<signoff>.
const RESULTS = /^\/results\/([0-9a-f]{40})(?:\/([a-z][a-z0-9-]*))?\/?$/;
const PULL = /^\/pr\/(\d+)(\/files(?:\/([a-z0-9-]+))?)?\/?$/;

/** The list at `/`, a pull request's conversation or review, or nothing. */
export const App: FC = () => {
  const pathname = usePathname();
  if (pathname === '/') return <PullListPage />;
  const results = pathname.match(RESULTS);
  if (results?.[1]) return <ResultsPage sha={results[1]} signoff={results[2]} />;
  const pull = pathname.match(PULL);
  if (pull) {
    return <PullPage number={Number(pull[1])} tab={pull[2] ? 'files' : 'conversation'} chapter={pull[3]} />;
  }
  return (
    <main className="page narrow">
      <h1>Nothing here</h1>
      <p>
        Pull requests are at <code>/pr/&lt;number&gt;</code>. <Link to="/">See them all.</Link>
      </p>
    </main>
  );
};
