import { useState, type FC } from 'react';
import { SpeakerHighIcon, SpeakerLowIcon, SpeakerSlashIcon } from '@phosphor-icons/react';
import { Button } from '@conservationtv/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@conservationtv/ui/components/popover';
import { Slider } from '@conservationtv/ui/components/slider';
import { Switch } from '@conservationtv/ui/components/switch';

import { FormError } from '@/components/common/form-error';

// How loud something is in a show, kept compact: one small speaker button that says at a glance whether it is muted or
// turned down, opening a level and a mute switch. A level is in decibels, 0 being standard volume, as the API keeps it.

/** The quietest and loudest a level can be set to, as the API takes it. */
const MIN_DB = -60;
const MAX_DB = 12;

/** A level and whether it is muted, and what a change to either sends. */
export interface Sound {
  volumeDb: number;
  muted: boolean;
}

export interface SoundControlProps extends Sound {
  /** What the sound is of, for its button's label and its popover's heading: "Serval (east)", "The show". */
  label: string;
  /** Sets the level or the mute; only what changed is given. */
  onSoundChange: (change: Partial<Sound>) => void;
  /** Why the last change was refused, if it was. */
  error?: Error | null;
}

/**
 * A speaker button showing whether it is muted or turned down, opening a level slider and a mute switch. The level is
 * sent once it is let go, not on every step; the slider shows where it is while it moves.
 */
export const SoundControl: FC<SoundControlProps> = ({ label, volumeDb, muted, onSoundChange, error = null }) => {
  const [moving, setMoving] = useState<number | null>(null);
  const level = moving ?? volumeDb;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Sound of ${label}: ${describeSound({ volumeDb, muted })}`}
            className={muted ? 'text-muted-foreground' : undefined}
          />
        }
      >
        <SpeakerIcon volumeDb={volumeDb} muted={muted} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 gap-3">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate font-medium">{label}</span>
          <span className="text-muted-foreground tabular-nums">{formatLevel(level)}</span>
        </div>
        <Slider
          aria-label={`Level of ${label}`}
          min={MIN_DB}
          max={MAX_DB}
          step={1}
          value={level}
          onValueChange={value => setMoving(firstOf(value))}
          onValueCommitted={value => {
            setMoving(null);
            onSoundChange({ volumeDb: firstOf(value) });
          }}
        />
        <label className="flex items-center justify-between gap-2">
          <span>Muted</span>
          <Switch size="sm" checked={muted} onCheckedChange={checked => onSoundChange({ muted: checked })} />
        </label>
        <FormError error={error} />
      </PopoverContent>
    </Popover>
  );
};

/** A slider's value as one number, whether it gives one or a list. */
function firstOf(value: number | readonly number[]): number {
  return [value].flat()[0] ?? 0;
}

/** A level as it is read: "0 dB", "−6 dB", "+3 dB". */
function formatLevel(volumeDb: number): string {
  if (volumeDb === 0) return '0 dB';
  return `${volumeDb > 0 ? '+' : '−'}${String(Math.abs(volumeDb))} dB`;
}

/** What the button says about the sound: muted, or its level. */
function describeSound({ volumeDb, muted }: Sound): string {
  return muted ? 'muted' : formatLevel(volumeDb);
}

/** Muted, turned down, or at standard volume and above. */
const SpeakerIcon: FC<Sound> = ({ volumeDb, muted }) => {
  if (muted) return <SpeakerSlashIcon />;
  if (volumeDb < 0) return <SpeakerLowIcon />;
  return <SpeakerHighIcon />;
};
