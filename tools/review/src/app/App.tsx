import type { FC } from 'react';
import { PullListPage } from './pages/PullListPage.tsx';
import { PullPage } from './pages/PullPage.tsx';
import { Link } from './components/Link.tsx';
import { usePathname } from './router.ts';

// /pr/12, /pr/12/files, /pr/12/files/<chapter> and /pr/12/files/api/<operation>.
const PULL = /^\/pr\/(\d+)(\/files(?:\/([a-z]+)(?:\/([^/]+))?)?)?\/?$/;

/** The list at `/`, a pull request's conversation or review, or nothing. */
export const App: FC = () => {
  const pathname = usePathname();
  if (pathname === '/') return <PullListPage />;
  const pull = pathname.match(PULL);
  if (pull) {
    return (
      <PullPage
        number={Number(pull[1])}
        tab={pull[2] ? 'files' : 'conversation'}
        chapter={pull[3]}
        operation={pull[4] ? decodeURIComponent(pull[4]) : undefined}
      />
    );
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
