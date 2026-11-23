import type { ScenarioReport, ScenarioShot } from '@conservationtv/runner/scenarios';
import { Badge } from '@conservationtv/ui/components/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@conservationtv/ui/components/dialog';
import { ToggleGroup, ToggleGroupItem } from '@conservationtv/ui/components/toggle-group';
import { cn } from '@conservationtv/ui/lib/utils';
import { useState, type FC } from 'react';
import { scenarioFile } from '../api.ts';

// The scenarios report (tools/runner, apps/studio/scenarios) drawn from its report.json: every page of every generated
// world, light and dark, at the head, leading with what changed most from the merge base and then what has issues.
// A shot opens large, as it was, as it is, and as the difference between them.

type Filter = 'changed' | 'issues' | 'all';

function changeOf(shot: ScenarioShot): number {
  return shot.difference?.ratio ?? 0;
}

/** Most changed first, then those with issues, then the run's own order. */
function byInterest(a: ScenarioShot, b: ScenarioShot): number {
  return changeOf(b) - changeOf(a) || b.issues.length - a.issues.length || a.order - b.order;
}

function percent(ratio: number): string {
  if (ratio === 0) return 'unchanged';
  return ratio < 0.001 ? '<0.1%' : `${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)}%`;
}

const filters = {
  changed: (shot: ScenarioShot) => changeOf(shot) > 0,
  issues: (shot: ScenarioShot) => shot.issues.length > 0,
  all: () => true
} satisfies Record<Filter, (shot: ScenarioShot) => boolean>;

interface ShotCardProps {
  sha: string;
  shot: ScenarioShot;
  scenario: string;
  onOpen(): void;
}

/** A shot's first screen, what it is of, and how far it changed or what is wrong on it. */
const ShotCard: FC<ShotCardProps> = ({ sha, shot, scenario, onOpen }) => (
  <button
    type="button"
    onClick={onOpen}
    className="flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left hover:border-foreground/40"
  >
    <img
      src={scenarioFile(sha, shot.thumb)}
      alt=""
      loading="lazy"
      className="aspect-[16/10] w-full object-cover object-top"
    />
    <span className="flex flex-col gap-1 p-2 text-xs">
      <span className="flex items-center gap-1.5">
        <strong className="truncate text-[13px]">{shot.pageTitle}</strong>
        {changeOf(shot) > 0 ? (
          <Badge variant="outline" className="ml-auto border-(--warning) text-(--warning)">
            {percent(changeOf(shot))}
          </Badge>
        ) : null}
      </span>
      <span className="truncate text-muted-foreground">
        {scenario} · {shot.theme}
        {shot.viewport === 'desktop' ? '' : ` · ${shot.viewport}`}
      </span>
      {shot.issues.length ? (
        <span className="truncate text-destructive">
          {shot.issues.length} issue{shot.issues.length === 1 ? '' : 's'}: {shot.issues[0]}
        </span>
      ) : null}
    </span>
  </button>
);

type View = 'after' | 'before' | 'diff';

interface ViewSwitchProps {
  view: View;
  onView(view: View): void;
}

/** As it was at the merge base, as it is, or the changed pixels. */
const ViewSwitch: FC<ViewSwitchProps> = ({ view, onView }) => (
  <ToggleGroup
    variant="outline"
    size="sm"
    spacing={0}
    value={[view]}
    onValueChange={([next]) => {
      if (next === 'after' || next === 'before' || next === 'diff') onView(next);
    }}
  >
    <ToggleGroupItem value="before">Merge base</ToggleGroupItem>
    <ToggleGroupItem value="after">Head</ToggleGroupItem>
    <ToggleGroupItem value="diff">Difference</ToggleGroupItem>
  </ToggleGroup>
);

interface ShotNotesProps {
  shot: ScenarioShot;
}

/** Everything noted on the page: its issues, errors the page or console raised, and calls to the mock that failed. */
const ShotNotes: FC<ShotNotesProps> = ({ shot }) => {
  const notes = [...shot.issues, ...shot.pageErrors, ...shot.consoleErrors, ...shot.apiFailures];
  if (!notes.length) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-destructive">
      {notes.map((note, index) => (
        <li key={index}>{note}</li>
      ))}
    </ul>
  );
};

/** Where the shot is of, how, and how far it changed. */
function describe(shot: ScenarioShot): string {
  const parts = [shot.path, shot.theme, shot.viewport];
  if (shot.difference) parts.push(`${percent(shot.difference.ratio)} changed`);
  if (shot.redirectedTo) parts.push(`went to ${shot.redirectedTo}`);
  return parts.join(' · ');
}

/** The image a view shows: the merge base's or the difference only when the shot has one, else the head's. */
function fileFor(shot: ScenarioShot, view: View): string {
  if (view === 'before') return shot.difference?.baselineFile ?? shot.file;
  if (view === 'diff') return shot.difference?.diffFile ?? shot.file;
  return shot.file;
}

interface ShotDetailProps {
  sha: string;
  shot: ScenarioShot;
  scenario: string;
  onClose(): void;
}

/** A shot large: as it is, as it was at the merge base, or the changed pixels; and everything noted about the page. */
const ShotDetail: FC<ShotDetailProps> = ({ sha, shot, scenario, onClose }) => {
  const [view, setView] = useState<View>(shot.difference?.diffFile ? 'diff' : 'after');
  return (
    <Dialog open onOpenChange={open => (open ? null : onClose())}>
      <DialogContent className="flex max-h-[92vh] w-[min(1200px,96vw)] max-w-none flex-col gap-3 sm:max-w-none">
        <DialogHeader>
          <DialogTitle>
            {shot.pageTitle} · {scenario}
          </DialogTitle>
          <DialogDescription>{describe(shot)}</DialogDescription>
        </DialogHeader>
        {shot.difference?.baselineFile ? <ViewSwitch view={view} onView={setView} /> : null}
        <ShotNotes shot={shot} />
        <div className="min-h-0 overflow-auto rounded-md border border-border">
          <img src={scenarioFile(sha, fileFor(shot, view))} alt={`${shot.pageTitle}, ${view}`} className="w-full" />
        </div>
      </DialogContent>
    </Dialog>
  );
};

interface ScreensViewProps {
  sha: string;
  report: ScenarioReport;
}

/** Every shot, filtered to what changed (or what has issues, or all) and to a theme, most interesting first. */
export const ScreensView: FC<ScreensViewProps> = ({ sha, report }) => {
  const changed = report.shots.filter(filters.changed).length;
  const withIssues = report.shots.filter(filters.issues).length;
  const [filter, setFilter] = useState<Filter>(changed ? 'changed' : withIssues ? 'issues' : 'all');
  const [theme, setTheme] = useState<string>('all');
  const [open, setOpen] = useState<ScenarioShot | null>(null);
  const titles = new Map(report.scenarios.map(scenario => [scenario.id, scenario.title]));
  const shots = report.shots
    .filter(filters[filter])
    .filter(shot => theme === 'all' || shot.theme === theme)
    .toSorted(byInterest);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
      <header className="intro flex flex-col gap-2">
        <h2>Screens</h2>
        <p className="text-[13px] text-muted-foreground">
          {report.shots.length} shots of {report.scenarios.length} generated worlds
          {report.baseline
            ? `, compared with the merge base (${report.baseline.commit.slice(0, 7)}): ${changed} changed`
            : ': not compared, as the merge base did not build'}
          , {withIssues} with issues.
          {report.removed.length ? ` ${report.removed.length} shots the merge base had weren't taken.` : ''}
        </p>
        <div className="flex flex-wrap gap-2">
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={0}
            value={[filter]}
            onValueChange={([next]) => {
              if (next === 'changed' || next === 'issues' || next === 'all') setFilter(next);
            }}
          >
            <ToggleGroupItem value="changed">Changed {changed}</ToggleGroupItem>
            <ToggleGroupItem value="issues">Issues {withIssues}</ToggleGroupItem>
            <ToggleGroupItem value="all">All {report.shots.length}</ToggleGroupItem>
          </ToggleGroup>
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={0}
            value={[theme]}
            onValueChange={([next]) => {
              if (next) setTheme(next);
            }}
          >
            <ToggleGroupItem value="all">Both</ToggleGroupItem>
            <ToggleGroupItem value="light">Light</ToggleGroupItem>
            <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </header>
      {shots.length ? (
        <div className={cn('grid gap-3 pb-16', 'grid-cols-[repeat(auto-fill,minmax(240px,1fr))]')}>
          {shots.map(shot => (
            <ShotCard
              key={shot.key}
              sha={sha}
              shot={shot}
              scenario={titles.get(shot.scenario) ?? shot.scenario}
              onOpen={() => setOpen(shot)}
            />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground">Nothing here.</p>
      )}
      {open ? (
        <ShotDetail
          sha={sha}
          shot={open}
          scenario={titles.get(open.scenario) ?? open.scenario}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
};
