import type { FC, ReactNode } from 'react';
import { BroadcastIcon, CloudIcon, HardDrivesIcon, TwitchLogoIcon } from '@phosphor-icons/react';
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@conservationtv/ui/components/item';

import { Section, SectionDescription, SectionHeader, SectionHeading, SectionTitle } from '@/components/common/page';
import { StatusLabel } from '@/components/common/status';
import { PART_LINES, SHOW_LINES, useShowChart } from '@/components/shows/show-charts';
import type { ShowDetail } from '@/components/shows/show-detail';
import { BitrateChart, BitrateChartLegend } from '@/components/streams/stream-chart';
import { statusLabels } from '@/components/streams/topology';
import { anyReported, type BitrateRow, type ChartWindow } from '@/components/streams/stream-charts';

export interface ShowTrafficProps {
  detail: ShowDetail;
}

/**
 * A show's traffic over the last three hours: the programme and what goes out of it, then each channel and preview
 * on its own line. Says so where nothing was reported, as a flat line alone reads like a show sending nothing.
 * Suspends until the series are read.
 */
export const ShowTraffic: FC<ShowTrafficProps> = ({ detail }) => {
  const { chartWindow, rows, parts } = useShowChart(detail.show);
  return (
    <div className="flex flex-col gap-10">
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>Programme</SectionTitle>
            <SectionDescription>
              What OBS sends, and what goes out of it to channels and previews, in bits a second.
            </SectionDescription>
          </SectionHeading>
          <BitrateChartLegend lines={SHOW_LINES} />
        </SectionHeader>
        <div className="flex flex-col gap-2">
          <BitrateChart lines={SHOW_LINES} rows={rows} from={chartWindow.from} to={chartWindow.to} className="h-52" />
          {!anyReported(rows) && (
            <p className="text-custom-12 text-muted-foreground">
              Nothing has reported traffic in the last three hours. The output agent reports it while OBS runs the show.
            </p>
          )}
        </div>
      </Section>
      {(detail.forwards.length > 0 || detail.previews.length > 0) && (
        <Section>
          <SectionHeader>
            <SectionHeading>
              <SectionTitle>Each way out</SectionTitle>
              <SectionDescription>What each channel and preview is sent of the programme.</SectionDescription>
            </SectionHeading>
          </SectionHeader>
          <ItemGroup className="gap-2">
            {detail.forwards.map(part => (
              <PartTraffic key={part.forward.id} rows={parts.get(part.forward.id) ?? []} chartWindow={chartWindow}>
                {/* A forward that is off says so in place of its health: nothing is sent to it to report on. */}
                <ItemMedia variant="icon">
                  {part.channel?.kind === 'twitch' ? <TwitchLogoIcon /> : <BroadcastIcon />}
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle className="flex-wrap">
                    {part.name}
                    {part.forward.enabled ? (
                      <StatusLabel status={part.status}>{statusLabels[part.status]}</StatusLabel>
                    ) : (
                      <StatusLabel status="unknown">Off</StatusLabel>
                    )}
                  </ItemTitle>
                </ItemContent>
              </PartTraffic>
            ))}
            {detail.previews.map(part => (
              <PartTraffic key={part.preview.id} rows={parts.get(part.preview.id) ?? []} chartWindow={chartWindow}>
                <ItemMedia variant="icon">{part.gateway?.networkId ? <HardDrivesIcon /> : <CloudIcon />}</ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle className="flex-wrap">
                    {part.name}
                    <StatusLabel status={part.status}>{statusLabels[part.status]}</StatusLabel>
                  </ItemTitle>
                </ItemContent>
              </PartTraffic>
            ))}
          </ItemGroup>
        </Section>
      )}
    </div>
  );
};

interface PartTrafficProps {
  rows: BitrateRow[];
  chartWindow: ChartWindow;
  /** What it is: its ItemMedia and ItemContent. */
  children: ReactNode;
}

/** A forward's or preview's card: what it is, then a sparkline of what it was sent, or that nothing was reported. */
const PartTraffic: FC<PartTrafficProps> = ({ rows, chartWindow, children }) => {
  const reported = anyReported(rows);
  return (
    <Item variant="outline" className="flex-col flex-nowrap items-stretch">
      <div className="flex items-start gap-2.5">
        {children}
        {!reported && <span className="text-custom-12 text-muted-foreground">Nothing reported</span>}
      </div>
      {reported && (
        <BitrateChart lines={PART_LINES} rows={rows} from={chartWindow.from} to={chartWindow.to} className="h-20" />
      )}
    </Item>
  );
};
