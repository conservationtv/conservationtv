import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Where OBS keeps its configuration, and what the agent writes there before each launch. The agent owns this OBS, so
// its configuration is the agent's alone, never the user's own OBS's:
//
//   Windows  portable mode (`--portable`), run from `bin/64bit`: `config/obs-studio` in the install itself, two folders
//            up from the executable. A new release starts from a fresh configuration, which this writes again.
//   macOS    OBS's release has no portable mode, but finds its config folder through Foundation, which takes the home
//            folder from `CFFIXED_USER_HOME` when it is set: so a home of the agent's own, and its
//            `Library/Application Support/obs-studio`.
//
// What it writes: obs-websocket enabled on the agent's port, with a password of the agent's; the first-run wizard
// marked as done; the crash sentinel cleared, so a stop the agent made (which OBS takes for a crash) doesn't bring
// up the Safe Mode prompt, which would also leave obs-websocket off; and the `vignette` profile and scene collection
// OBS is launched with (`--profile`, `--collection`). The profile is rewritten before every launch from the plan's
// output: x264 at a constant bitrate, keyframes every `keyframeSeconds`, AAC 48 kHz stereo, streaming to the program
// MediaMTX (program.ts), whose fallback has the same tracks. OBS never sees a channel's stream key. The collection is
// written only if it is missing: OBS keeps it, and vignette's target owns the scenes in it.

/** How OBS is started for an install: the executable, its arguments, where it runs, and its environment. */
export interface ObsLaunch {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** The `obs-studio` config folder this launch reads. */
  config: string;
}

/** The profile and scene collection the agent writes, and launches OBS with. */
export const OBS_PROFILE = 'vignette';
export const OBS_COLLECTION = 'vignette';

/**
 * Arguments for every launch: no updater, no dialogs about missing files, no refusing to run beside another OBS, the
 * agent's profile and collection, and streaming from the start, so a restarted OBS streams again by itself.
 */
const ARGS = [
  ['--disable-updater', '--disable-missing-files-check', '--multi'],
  ['--profile', OBS_PROFILE, '--collection', OBS_COLLECTION, '--startstreaming']
].flat();

/** How to launch the OBS at `executable`, keeping a macOS home under `directory`. */
export function obsLaunch(executable: string, directory: string): ObsLaunch {
  if (process.platform === 'win32') {
    const binaries = dirname(executable);
    const install = dirname(dirname(binaries));
    return { args: ['--portable', ...ARGS], cwd: binaries, env: {}, config: join(install, 'config', 'obs-studio') };
  }
  const home = join(directory, 'home');
  return {
    args: ARGS,
    cwd: directory,
    env: { CFFIXED_USER_HOME: home },
    config: join(home, 'Library', 'Application Support', 'obs-studio')
  };
}

/** obs-websocket's settings, as its `config.json` names them. */
interface WebsocketSettings {
  first_load: boolean;
  server_enabled: boolean;
  server_port: number;
  alerts_enabled: boolean;
  auth_required: boolean;
  server_password: string;
}

/** Writes what OBS needs to start unattended and serve obs-websocket on `port` with `password`. */
export async function writeObsSettings(config: string, port: number, password: string): Promise<void> {
  const websocket: WebsocketSettings = {
    first_load: false,
    server_enabled: true,
    server_port: port,
    alerts_enabled: false,
    auth_required: true,
    server_password: password
  };
  const websocketFile = join(config, 'plugin_config', 'obs-websocket', 'config.json');
  await mkdir(dirname(websocketFile), { recursive: true });
  await writeFile(websocketFile, JSON.stringify(websocket, null, 2), { mode: 0o600 });
  await markFirstRunDone(join(config, 'user.ini'));
  await rm(join(config, '.sentinel'), { recursive: true, force: true });
}

/** `FirstRun=true` in `[General]`, which skips the auto-configuration wizard. Left as it is once OBS has written it. */
async function markFirstRunDone(userIni: string): Promise<void> {
  const exists = await access(userIni).then(
    () => true,
    () => false
  );
  if (exists) return;
  await writeFile(userIni, '[General]\nFirstRun=true\n');
}

/** The agent's obs-websocket password, made the first time and kept in `directory` from then on. */
export async function websocketPassword(directory: string): Promise<string> {
  const file = join(directory, 'websocket-password');
  const kept = await readFile(file, 'utf8').catch(() => undefined);
  if (kept !== undefined && kept.trim() !== '') return kept.trim();
  const password = randomBytes(24).toString('base64url');
  await mkdir(directory, { recursive: true });
  await writeFile(file, password, { mode: 0o600 });
  return password;
}

/** How the program is encoded, as the plan gives it. */
export interface ObsOutput {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  keyframeSeconds: number;
}

/** Where OBS streams: a custom RTMP server and stream key. */
export interface ObsStreamTarget {
  server: string;
  key: string;
}

/** The audio bitrate, in kbps: AAC-LC stereo, as Twitch recommends. */
const AUDIO_BITRATE_KBPS = 160;

/** An INI file's text, section by section. */
function ini(sections: Record<string, Record<string, string | number | boolean>>): string {
  return Object.entries(sections)
    .map(([section, values]) => {
      const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value)}`);
      return [`[${section}]`, ...lines].join('\n');
    })
    .join('\n\n')
    .concat('\n');
}

/** Writes the `vignette` profile, encoding `output` and streaming to `target`, and the collection if it is missing. */
export async function writeObsProfile(config: string, output: ObsOutput, target: ObsStreamTarget): Promise<void> {
  const profile = join(config, 'basic', 'profiles', OBS_PROFILE);
  await mkdir(profile, { recursive: true });
  const basic = ini({
    General: { Name: OBS_PROFILE },
    Output: { Mode: 'Advanced' },
    AdvOut: {
      Encoder: 'obs_x264',
      TrackIndex: 1,
      ApplyServiceSettings: false,
      VodTrackEnabled: false,
      AudioEncoder: 'ffmpeg_aac',
      Track1Bitrate: AUDIO_BITRATE_KBPS,
      Rescale: false
    },
    Video: {
      BaseCX: output.width,
      BaseCY: output.height,
      OutputCX: output.width,
      OutputCY: output.height,
      FPSType: 1,
      FPSInt: output.fps,
      ColorFormat: 'NV12',
      ColorSpace: '709',
      ColorRange: 'Partial'
    },
    Audio: { SampleRate: 48_000, ChannelSetup: 'Stereo' }
  });
  const encoder = {
    rate_control: 'CBR',
    bitrate: output.bitrateKbps,
    keyint_sec: output.keyframeSeconds,
    preset: 'veryfast',
    profile: 'high',
    tune: ''
  };
  const service = {
    type: 'rtmp_custom',
    settings: { server: target.server, key: target.key, use_auth: false, bwtest: false }
  };
  await writeFile(join(profile, 'basic.ini'), basic);
  await writeFile(join(profile, 'streamEncoder.json'), JSON.stringify(encoder, null, 2));
  await writeFile(join(profile, 'service.json'), JSON.stringify(service, null, 2));
  await writeCollection(join(config, 'basic', 'scenes', `${OBS_COLLECTION}.json`));
}

/** An empty scene collection, for OBS to keep from then on. */
async function writeCollection(file: string): Promise<void> {
  const exists = await access(file).then(
    () => true,
    () => false
  );
  if (exists) return;
  await mkdir(dirname(file), { recursive: true });
  const collection = {
    name: OBS_COLLECTION,
    current_scene: '',
    current_program_scene: '',
    scene_order: [],
    sources: []
  };
  await writeFile(file, JSON.stringify(collection, null, 2));
}
