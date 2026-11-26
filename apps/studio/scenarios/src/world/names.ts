import type { Rng } from './rng.ts';

// What things are called. `normal` names read like a real sanctuary's; `long` ones push every label to the length and
// characters the API accepts, to find what wraps, truncates or overflows.

export type NameStyle = 'normal' | 'long';

const SITES = [
  'Hilltop Enclosure',
  'Riverside',
  'North Paddock',
  'Visitor Centre',
  'Reptile House',
  'Wetland Hide',
  'Orchard Field',
  'Quarantine Block',
  'Lakeside',
  'Woodland Walk',
  'Barn',
  'Nursery'
];

const SUBJECTS = [
  'Tortoise',
  'Otter',
  'Meerkat',
  'Red panda',
  'Lemur',
  'Owl',
  'Capybara',
  'Flamingo',
  'Badger',
  'Hedgehog',
  'Kestrel',
  'Pond',
  'Feeding station',
  'Nest box',
  'Burrow',
  'Gate'
];

const ANGLES = ['cam', 'wide', 'close-up', 'overhead', 'east', 'west', 'night', 'PTZ'];

const ORGANISATIONS = [
  'Simulo Sanctuary',
  'Fenland Otter Trust',
  'Highmoor Wildlife Park',
  'Saltmarsh Bird Reserve',
  'Little Oaks Rescue'
];

const SHOWS = ['Live from the sanctuary', 'Night watch', 'Feeding time', 'Nest cam', 'Quiet hours', 'Highlights'];

const CHANNEL_LOGINS = ['simulosanctuary', 'otterwatch', 'nestcamlive', 'thebadgerset', 'wildlifewindow'];

const PEOPLE = [
  'Alex Morgan',
  'Priya Shah',
  'Sam Okafor',
  'Jo Lindqvist',
  'Mei Chen',
  'Tomás Ruiz',
  'Hannah Webb',
  'Kofi Mensah',
  'Ines Duarte',
  'Ravi Patel',
  'Grace O’Neill',
  'Yusuf Demir'
];

/** A long, awkward version of a name: near the limits, with spaces, punctuation and non-Latin text to wrap on. */
function longer(rng: Rng, name: string): string {
  const suffix = rng.pick([
    ' — temporary rehabilitation enclosure (east side, behind the old feed store)',
    ' / Überwachungskamera Nordgehege Außenbereich',
    ' (camera mounted on the far fence post, pointing towards the water)',
    ' – 野生動物保護区の監視カメラ',
    'WithAnExtremelyLongUnbrokenIdentifierThatWillNotWrapAnywhere'
  ]);
  return `${name}${suffix}`;
}

/** The item at `index`, wrapping round the list. */
function nth(items: readonly string[], index: number): string {
  // SAFETY: the lists here are non-empty constants, and the index is taken modulo their length.
  return items[index % items.length] as string;
}

/** Streams someone publishes to rather than a camera feeding them: an encoder, a phone, a laptop. */
const PUSHED = ['OBS studio', 'Keeper’s phone', 'Vet room encoder', 'Drone', 'Education talks', 'Visitor kiosk'];

const PRESETS = ['Home', 'Water', 'Feeding', 'Nest', 'Wide', 'Gate', 'Shelter', 'Close-up'];
const COMMANDS = ['!cam', '!otters', '!feed', '!wide', '!nest', '!hello', '!rules', '!zoom'];

/** A channel's name, and its login on the platform when it has one. */
export interface ChannelName {
  name: string;
  login: string | null;
}

/** A person's name and email address. */
export interface Person {
  name: string;
  email: string;
}

export class Namer {
  constructor(
    private readonly style: NameStyle,
    private readonly rng: Rng
  ) {}

  private styled(rng: Rng, name: string): string {
    return this.style === 'long' && rng.chance(0.7) ? longer(rng, name) : name;
  }

  organisation(index: number): string {
    const rng = this.rng.child('organisation', index);
    return this.styled(rng, nth(ORGANISATIONS, index));
  }

  network(index: number): string {
    const rng = this.rng.child('network', index);
    const base = nth(SITES, index);
    return this.styled(rng, index >= SITES.length ? `${base} ${Math.floor(index / SITES.length) + 1}` : base);
  }

  agent(networkName: string, index: number): string {
    const rng = this.rng.child('agent', networkName, index);
    const host = rng.pick(['pi', 'nuc', 'mini', 'box']);
    const slug = networkName
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-|-$/gu, '')
      .slice(0, 24);
    return this.styled(rng, `${slug || 'site'}-${host}-${index + 1}`);
  }

  camera(index: number): string {
    const rng = this.rng.child('camera', index);
    return this.styled(rng, `${rng.pick(SUBJECTS)} ${rng.pick(ANGLES)}`);
  }

  stream(cameraName: string, index: number): string {
    if (index === 0) return cameraName;
    return `${cameraName} (${['backup', 'low bandwidth', 'archive', 'second feed'][index - 1] ?? `feed ${index + 1}`})`;
  }

  /** A shared pushed stream: what publishes to it, as people name such a stream. */
  pushed(index: number): string {
    const rng = this.rng.child('pushed', index);
    const base = nth(PUSHED, index);
    return this.styled(rng, index >= PUSHED.length ? `${base} ${Math.floor(index / PUSHED.length) + 1}` : base);
  }

  gateway(networkName: string, index: number): string {
    const rng = this.rng.child('gateway', networkName, index);
    return this.styled(rng, `${networkName} MediaMTX${index ? ` ${index + 1}` : ''}`);
  }

  show(index: number): string {
    const rng = this.rng.child('show', index);
    const base = nth(SHOWS, index);
    return this.styled(rng, index >= SHOWS.length ? `${base} ${Math.floor(index / SHOWS.length) + 1}` : base);
  }

  output(showName: string | null, index: number): string {
    const rng = this.rng.child('output', index);
    return this.styled(
      rng,
      showName ? `${showName} — ${rng.pick(['OBS', 'Main', 'Backup'])}` : `External OBS ${index + 1}`
    );
  }

  channel(index: number, kind: 'twitch' | 'rtmp'): ChannelName {
    const rng = this.rng.child('channel', index);
    if (kind === 'twitch') {
      const login = `${nth(CHANNEL_LOGINS, index)}${index >= CHANNEL_LOGINS.length ? index : ''}`;
      return { name: this.styled(rng, login), login };
    }
    return {
      name: this.styled(rng, rng.pick(['YouTube Live', 'Facebook Live', 'Restream', 'Archive server'])),
      login: null
    };
  }

  person(index: number): Person {
    const name = nth(PEOPLE, index);
    const local = name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z ]/gu, '')
      .replace(/ +/gu, '.');
    const suffix = index >= PEOPLE.length ? String(Math.floor(index / PEOPLE.length)) : '';
    return { name: this.styled(this.rng.child('person', index), name), email: `${local}${suffix}@example.org` };
  }

  preset(index: number): string {
    return nth(PRESETS, index);
  }

  command(index: number): string {
    return nth(COMMANDS, index);
  }

  /** A command that operates a show, the `count`th of its kind: `!swap`, then `!swap2`. */
  showCommand(kind: 'showSwap' | 'showTakeover', count: number): string {
    return `${kind === 'showSwap' ? '!swap' : '!takeover'}${count ? count + 1 : ''}`;
  }
}
