import { useState, type FC } from 'react';

import { Button } from '@conservationtv/ui/components/button';
import { Input } from '@conservationtv/ui/components/input';
import { Label } from '@conservationtv/ui/components/label';

const streams = [
  {
    name: 'Main server',
    destination: 'Cloudflare',
    status: 'Recording',
    colour: 'custom-recording'
  },
  {
    name: 'Serval',
    destination: 'Alveus Sanctuary',
    status: 'Connected',
    colour: 'custom-connection'
  },
  {
    name: 'Backup stream',
    destination: 'Cloudflare',
    status: 'Warning',
    colour: 'custom-warning'
  },
  {
    name: 'Archive',
    destination: 'Local storage',
    status: 'Error',
    colour: 'destructive'
  }
];

const swatches = [
  { name: 'Background', token: 'background' },
  { name: 'Surface', token: 'card' },
  { name: 'Sidebar', token: 'sidebar' },
  { name: 'Accent', token: 'accent' },
  { name: 'Primary', token: 'primary' },
  { name: 'Muted', token: 'muted' },
  { name: 'Border', token: 'border' },
  { name: 'Warning', token: 'custom-warning' },
  { name: 'Destructive', token: 'destructive' }
];

export const ThemeSample: FC = () => {
  const [query, setQuery] = useState('');
  const filteredStreams = streams.filter(stream =>
    `${stream.name} ${stream.destination} ${stream.status}`.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-6">
      <div>
        <p className="text-custom-11 font-medium text-muted-foreground">CUSTOM THEME</p>
        <h1 className="mt-1 text-custom-21 font-bold">Graphite & taupe</h1>
        <p className="mt-2 max-w-xl text-custom-13 text-custom-text-secondary">
          Your Figtree typography and light/dark palette, applied to shadcn sidebar blocks.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="rounded-xl border bg-card p-5 text-card-foreground shadow-sm shadow-custom-surface-shadow lg:col-span-2">
          <h2 className="text-custom-15 font-semibold">Colour palette</h2>
          <div className="mt-4 grid grid-cols-3 gap-4">
            {swatches.map(swatch => (
              <div key={swatch.token}>
                <div
                  className="h-12 rounded-md border"
                  style={{ backgroundColor: `var(--${swatch.token})` }}
                  aria-label={swatch.name}
                />
                <p className="mt-2 text-custom-11 font-medium">{swatch.name}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-xl border bg-card p-5 text-card-foreground shadow-sm shadow-custom-surface-shadow">
          <h2 className="text-custom-15 font-semibold">Chart colours</h2>
          <svg
            className="mt-6 h-40 w-full"
            viewBox="0 0 240 140"
            role="img"
            aria-label="Five chart series in the Custom palette"
          >
            {[80, 110, 65, 120, 95].map((height, index) => (
              <rect
                key={index}
                x={index * 48 + 8}
                y={140 - height}
                width={30}
                height={height}
                rx={4}
                fill={`var(--chart-${index + 1})`}
              />
            ))}
          </svg>
          <div className="mt-3 grid grid-cols-5 text-center text-custom-11 text-muted-foreground">
            {[1, 2, 3, 4, 5].map(series => (
              <span key={series}>{series}</span>
            ))}
          </div>
        </section>
      </div>

      <section className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm shadow-custom-surface-shadow">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-5">
          <h2 className="text-custom-15 font-semibold">Streams</h2>
          <div className="flex items-center gap-2">
            <Input
              aria-label="Filter streams"
              placeholder="Filter streams…"
              value={query}
              onChange={event => setQuery(event.target.value)}
              className="w-44"
            />
            {query && (
              <Button variant="ghost" onClick={() => setQuery('')}>
                Clear
              </Button>
            )}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-custom-13">
            <thead className="bg-muted text-custom-11 text-muted-foreground">
              <tr>
                <th className="px-5 py-3 font-medium">Stream</th>
                <th className="px-5 py-3 font-medium">Destination</th>
                <th className="px-5 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredStreams.map(stream => (
                <tr key={stream.name} className="border-t hover:bg-interaction-hover">
                  <td className="px-5 py-4 font-medium">{stream.name}</td>
                  <td className="px-5 py-4 text-custom-text-secondary">{stream.destination}</td>
                  <td className="px-5 py-4">
                    <span className="inline-flex items-center gap-2 text-custom-11">
                      <span className="size-1.5 rounded-full" style={{ backgroundColor: `var(--${stream.colour})` }} />
                      {stream.status}
                    </span>
                  </td>
                </tr>
              ))}
              {filteredStreams.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-5 py-8 text-center text-muted-foreground">
                    No streams match your search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border bg-card p-5 text-card-foreground shadow-sm shadow-custom-surface-shadow">
          <h2 className="text-custom-15 font-semibold">Component states</h2>
          <p className="mt-1 text-custom-12 text-muted-foreground">
            Hover or tab through the controls to compare their states.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="destructive">Destructive</Button>
            <Button disabled>Disabled</Button>
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="sample-input">Default input</Label>
              <Input id="sample-input" placeholder="Focus this input" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sample-invalid">Error input</Label>
              <Input
                id="sample-invalid"
                aria-invalid="true"
                aria-describedby="sample-error"
                defaultValue="Invalid example"
              />
              <p id="sample-error" className="text-custom-11 text-destructive">
                An example error state.
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-xl border bg-card p-5 text-card-foreground shadow-sm shadow-custom-surface-shadow">
          <h2 className="text-custom-15 font-semibold">Figtree</h2>
          <div className="mt-4 space-y-3 text-custom-13">
            <p className="font-normal">Regular · 400</p>
            <p className="font-medium">Medium · 500</p>
            <p className="font-semibold">Semibold · 600</p>
            <p className="font-extrabold">Extrabold · 800</p>
          </div>
          <p className="mt-5 text-custom-11 text-muted-foreground">Shadow colours follow the palette in both modes.</p>
        </section>
      </div>
    </div>
  );
};
