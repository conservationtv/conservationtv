import type { FC } from 'react';

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@conservationtv/ui/components/empty';

import type { Route } from './+types/go-live';
import { Page, PageDescription, PageHeader, PageHeading, PageTitle } from '@/components/common/page';
import { GoLive } from '@/components/go-live/go-live';
import { useMayPublish } from '@/hooks/use-organisation';

export const meta: Route.MetaFunction = () => [{ title: 'Go live · conservation.tv studio' }];

/**
 * Going live from this browser, a phone's or a computer's: a camera or a screen, sent to the organisation's shows as
 * your stream for this kind of device. Those with the right to publish (`streamPublisher`, which administrators hold);
 * anyone else is told who can let them, and the API refuses them regardless.
 */
const GoLiveRoute: FC = () => {
  const mayPublish = useMayPublish();
  return (
    <Page className="max-w-3xl gap-6">
      <PageHeader>
        <PageHeading>
          <PageTitle>Go live</PageTitle>
          <PageDescription>
            Send your camera or screen to the studio. A show’s controls offer it to take over once it is live.
          </PageDescription>
        </PageHeading>
      </PageHeader>
      {mayPublish ? (
        <GoLive />
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>You can’t go live here yet</EmptyTitle>
            <EmptyDescription>An administrator can let you on the organisation’s Members settings.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </Page>
  );
};

export default GoLiveRoute;
