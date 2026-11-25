import { Card, CardContent, CardHeader, CardTitle } from '@conservationtv/ui/components/card';
import { useQuery } from '@tanstack/react-query';
import type { FC } from 'react';
import type { ScenarioShot } from '@conservationtv/runner/scenarios';
import type { Review } from '../../shared/review.ts';
import { scenarioFile, scenariosQuery } from '../api.ts';
import { Link } from './Link.tsx';

// The scenarios report beside the conversation: how many shots changed from the merge base, and how many have issues,
// with the three that changed most, each opening the screens.

/** How far a shot changed from the merge base: 0 when it didn't, or wasn't compared. */
function ratioOf(shot: ScenarioShot): number {
  return shot.difference?.ratio ?? 0;
}

interface ScreensCardProps {
  review: Review;
}

/** Nothing without a scenarios report at the head; else its counts and the most changed shots. */
export const ScreensCard: FC<ScreensCardProps> = ({ review }) => {
  const { data: report } = useQuery(scenariosQuery(review.pull.headSha));
  if (!report) return null;
  const changed = report.shots.filter(shot => ratioOf(shot) > 0).toSorted((a, b) => ratioOf(b) - ratioOf(a));
  const issues = report.shots.filter(shot => shot.issues.length > 0).length;
  const link = `/pr/${review.pull.number}/files/screens`;
  return (
    <Card size="sm" className="gap-2 text-[13px]">
      <CardHeader>
        <CardTitle>Screens</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p>
          {report.baseline
            ? `${changed.length} of ${report.shots.length} shots changed`
            : `${report.shots.length} shots, not compared`}
          , {issues} with issues. <Link to={link}>See them</Link>
        </p>
        {changed.length ? (
          <div className="grid grid-cols-3 gap-1.5">
            {changed.slice(0, 3).map(shot => (
              <Link key={shot.key} to={link} title={shot.pageTitle}>
                <img
                  src={scenarioFile(review.pull.headSha, shot.difference?.diffThumb ?? shot.thumb)}
                  alt={shot.pageTitle}
                  loading="lazy"
                  className="aspect-[16/10] w-full rounded border border-border object-cover object-top"
                />
              </Link>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
};
