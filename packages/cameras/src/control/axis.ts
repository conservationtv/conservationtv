import type {
  CameraCapabilities,
  CameraMove,
  CameraOption,
  CameraOptionValues,
  CameraPosition,
  Drive,
  MoveBy,
  MoveTo,
  MoveToPoint,
  MoveToRegion,
  Range
} from '../contract.ts';
import type { AxisSettings, CameraCredentials } from '../settings.ts';
import { ChallengeAnswerer, fetchWithCredentials } from './digest.ts';
import { CameraFailure, type CameraDriver, UnsupportedCommand } from './driver.ts';

// An Axis camera, controlled by VAPIX's PTZ API (`/axis-cgi/com/ptz.cgi`) on its web server. Pan and tilt are degrees
// there too; zoom and focus are steps of the camera's own range (1 to 9999 on most), which `query=limits` gives, and
// continuous moves are speeds from -100 to 100. What it can do is asked of the camera, since a fixed camera and a PTZ
// one are registered alike: a camera whose limits give no travel on an axis doesn't have it.

const PTZ_PATH = '/axis-cgi/com/ptz.cgi';
const PARAM_PATH = '/axis-cgi/param.cgi';

/** The picture `center` and `areazoom` coordinates are given in: any size does, since the camera scales from it. */
const PICTURE = { width: 1920, height: 1080 };

/** The most `areazoom` zooms in by at once, as a percentage: a region a hundredth of the picture's width. */
const MAX_AREA_ZOOM = 10_000;

/** VAPIX's fastest continuous move. */
const FULL_SPEED = 100;

const AUTOFOCUS = 'autofocus';
const IR_CUT_FILTER = 'ircutfilter';
const IR_CUT_FILTER_PARAMETER = 'PTZ.Various.V1.IrCutFilter';
const IR_CUT_SUPPORT_GROUP = 'PTZ.Support.S1';

/** VAPIX's `name=value` lines, by lowercase name: a `root.` prefix, as `param.cgi` gives, is dropped. */
function parseLines(body: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of body.split(/\r?\n/u)) {
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const name = line.slice(0, equals).trim().replace(/^root\./u, '');
    values.set(name.toLowerCase(), line.slice(equals + 1).trim());
  }
  return values;
}

/** The range between two of the camera's limits, when it has both and they are apart. */
function rangeOf(limits: Map<string, string>, axis: string): Range | undefined {
  const min = Number(limits.get(`min${axis}`));
  const max = Number(limits.get(`max${axis}`));
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return undefined;
  return { min, max };
}

/** How far each axis the camera has travels: pan and tilt in degrees, zoom and focus in its own steps. */
interface Limits {
  pan: Range | undefined;
  tilt: Range | undefined;
  zoom: Range | undefined;
  focus: Range | undefined;
}

/** A fraction of a range, as one of the camera's steps. */
function toSteps(fraction: number, range: Range): number {
  return Math.round(range.min + fraction * (range.max - range.min));
}

/** One of the camera's steps, as a fraction of its range. */
function toFraction(steps: number, range: Range): number {
  const fraction = (steps - range.min) / (range.max - range.min);
  return Math.min(1, Math.max(0, fraction));
}

/** A velocity as VAPIX's speed, -100 to 100: an axis left out is not moved. */
function speed(velocity: number | undefined): number {
  return Math.round((velocity ?? 0) * FULL_SPEED);
}

/** The moves a camera with these limits takes. */
function movesOf(limits: Limits): CameraMove[] {
  const turns = limits.pan !== undefined || limits.tilt !== undefined;
  if (!turns && limits.zoom === undefined) return [];
  const moves: CameraMove[] = ['absolute', 'relative', 'continuous'];
  // Centring on a point of the picture needs both axes.
  if (limits.pan !== undefined && limits.tilt !== undefined) moves.push('point', 'region');
  return moves;
}

export class AxisDriver implements CameraDriver {
  private readonly base: URL;
  private readonly answerer: ChallengeAnswerer;
  /** The camera's limits, once it has given them: they don't change while it runs. */
  private limits: Limits | undefined = undefined;
  /** Whether focus was last driven, so stopping stops it too: a camera without manual focus refuses the parameter. */
  private focusDriven = false;

  constructor(settings: AxisSettings, credentials: CameraCredentials | undefined) {
    this.base = new URL(settings.host);
    this.answerer = new ChallengeAnswerer(credentials);
  }

  async capabilities(signal: AbortSignal): Promise<CameraCapabilities> {
    const limits = await this.readLimits(signal);
    const options: CameraOption[] = [];
    if (limits.focus !== undefined) options.push({ key: AUTOFOCUS, label: 'Autofocus', values: ['on', 'off'] });
    const irCutFilter = await this.irCutFilterOption(signal);
    if (irCutFilter !== undefined) options.push(irCutFilter);
    return {
      moves: movesOf(limits),
      pan: limits.pan,
      tilt: limits.tilt,
      zoom: limits.zoom !== undefined,
      focus: limits.focus !== undefined,
      options,
      actions: []
    };
  }

  async position(signal: AbortSignal): Promise<CameraPosition> {
    const limits = await this.readLimits(signal);
    const reported = await this.query('position', signal);
    return positionOf(reported, limits);
  }

  async options(signal: AbortSignal): Promise<CameraOptionValues> {
    const values: CameraOptionValues = {};
    const reported = await this.query('position', signal);
    const autofocus = reported.get(AUTOFOCUS);
    if (autofocus !== undefined) values[AUTOFOCUS] = autofocus;
    const irCutFilter = await this.parameters(IR_CUT_FILTER_PARAMETER, signal).catch(() => undefined);
    const filter = irCutFilter?.get(IR_CUT_FILTER_PARAMETER.toLowerCase());
    if (filter !== undefined) values[IR_CUT_FILTER] = filter;
    return values;
  }

  async moveTo(target: Omit<MoveTo, 'kind'>, signal: AbortSignal): Promise<void> {
    const limits = await this.readLimits(signal);
    // Each axis the target names, in the camera's units: pan and tilt as they are, zoom and focus as its steps.
    const parameters = new URLSearchParams();
    if (target.pan !== undefined) parameters.set('pan', String(target.pan));
    if (target.tilt !== undefined) parameters.set('tilt', String(target.tilt));
    if (target.zoom !== undefined) parameters.set('zoom', String(toSteps(target.zoom, required(limits.zoom, 'zoom'))));
    if (target.focus !== undefined)
      parameters.set('focus', String(toSteps(target.focus, required(limits.focus, 'focus'))));
    await this.ptz(parameters, signal);
  }

  async moveBy(offset: Omit<MoveBy, 'kind'>, signal: AbortSignal): Promise<void> {
    const limits = await this.readLimits(signal);
    const parameters = new URLSearchParams();
    if (offset.pan !== undefined) parameters.set('rpan', String(offset.pan));
    if (offset.tilt !== undefined) parameters.set('rtilt', String(offset.tilt));
    if (offset.zoom !== undefined) {
      const range = required(limits.zoom, 'zoom');
      parameters.set('rzoom', String(Math.round(offset.zoom * (range.max - range.min))));
    }
    await this.ptz(parameters, signal);
  }

  async moveToPoint(point: Omit<MoveToPoint, 'kind'>, signal: AbortSignal): Promise<void> {
    const parameters = pictureParameters();
    parameters.set('center', `${Math.round(point.x * PICTURE.width)},${Math.round(point.y * PICTURE.height)}`);
    await this.ptz(parameters, signal);
  }

  async moveToRegion(region: Omit<MoveToRegion, 'kind'>, signal: AbortSignal): Promise<void> {
    const x = Math.round((region.x + region.width / 2) * PICTURE.width);
    const y = Math.round((region.y + region.height / 2) * PICTURE.height);
    // Zoom in by however much makes the region's longer side fill the picture, as a percentage.
    const zoom = Math.min(MAX_AREA_ZOOM, Math.round(100 / Math.max(region.width, region.height)));
    const parameters = pictureParameters();
    parameters.set('areazoom', `${x},${y},${zoom}`);
    await this.ptz(parameters, signal);
  }

  async drive(velocity: Omit<Drive, 'kind'>, signal: AbortSignal): Promise<void> {
    // Pan and tilt are one parameter, so naming either sets both; zoom and focus are each their own.
    const parameters = new URLSearchParams();
    if (velocity.pan !== undefined || velocity.tilt !== undefined)
      parameters.set('continuouspantiltmove', `${speed(velocity.pan)},${speed(velocity.tilt)}`);
    if (velocity.zoom !== undefined) parameters.set('continuouszoommove', String(speed(velocity.zoom)));
    if (velocity.focus !== undefined) {
      parameters.set('continuousfocusmove', String(speed(velocity.focus)));
      this.focusDriven = true;
    }
    await this.ptz(parameters, signal);
  }

  async stop(signal: AbortSignal): Promise<void> {
    const limits = await this.readLimits(signal);
    // Only the axes the camera has: it refuses a request naming one it doesn't, without stopping the others.
    const parameters = new URLSearchParams();
    if (limits.pan !== undefined || limits.tilt !== undefined) parameters.set('continuouspantiltmove', '0,0');
    if (limits.zoom !== undefined) parameters.set('continuouszoommove', '0');
    if (this.focusDriven) parameters.set('continuousfocusmove', '0');
    this.focusDriven = false;
    await this.ptz(parameters, signal);
  }

  async configure(key: string, value: string, signal: AbortSignal): Promise<void> {
    if (key !== AUTOFOCUS && key !== IR_CUT_FILTER) throw new UnsupportedCommand(`set \`${key}\``);
    await this.ptz(new URLSearchParams({ [key]: value }), signal);
  }

  async run(action: string): Promise<void> {
    throw new UnsupportedCommand(`run \`${action}\``);
  }

  /** The camera's limits, asked once: a camera with no PTZ API at all has none. */
  private async readLimits(signal: AbortSignal): Promise<Limits> {
    if (this.limits !== undefined) return this.limits;
    const reported = await this.query('limits', signal).catch(error => {
      // A camera that answers, but not to this, is a fixed one; one that doesn't answer isn't known yet.
      if (error instanceof Refused) return new Map<string, string>();
      throw error;
    });
    const limits: Limits = {
      pan: rangeOf(reported, 'pan'),
      tilt: rangeOf(reported, 'tilt'),
      zoom: rangeOf(reported, 'zoom'),
      focus: rangeOf(reported, 'focus')
    };
    this.limits = limits;
    return limits;
  }

  /** The IR cut filter as an option, when the camera says it has one: with `auto` when it can switch it itself. */
  private async irCutFilterOption(signal: AbortSignal): Promise<CameraOption | undefined> {
    const support = await this.parameters(IR_CUT_SUPPORT_GROUP, signal).catch(() => undefined);
    const prefix = IR_CUT_SUPPORT_GROUP.toLowerCase();
    if (support?.get(`${prefix}.ircutfilter`) !== 'true') return undefined;
    const automatic = support.get(`${prefix}.autoircutfilter`) === 'true';
    return { key: IR_CUT_FILTER, label: 'IR cut filter', values: automatic ? ['auto', 'on', 'off'] : ['on', 'off'] };
  }

  private query(what: string, signal: AbortSignal): Promise<Map<string, string>> {
    return this.ptz(new URLSearchParams({ query: what }), signal);
  }

  /** One call to the PTZ API, with nothing to send when there is nothing to ask. */
  private async ptz(parameters: URLSearchParams, signal: AbortSignal): Promise<Map<string, string>> {
    if (parameters.size === 0) return new Map();
    parameters.set('camera', '1');
    return this.call(PTZ_PATH, parameters, signal);
  }

  private parameters(group: string, signal: AbortSignal): Promise<Map<string, string>> {
    return this.call(PARAM_PATH, new URLSearchParams({ action: 'list', group }), signal);
  }

  /** One request to the camera's web server, under the path it is registered at, to the lines it answers with. */
  private async call(path: string, parameters: URLSearchParams, signal: AbortSignal): Promise<Map<string, string>> {
    const url = new URL(`${this.base.pathname.replace(/\/+$/u, '')}${path}`, this.base);
    url.search = parameters.toString();
    const response = await fetchWithCredentials(this.answerer, url, { signal }).catch(cause => {
      throw new CameraFailure('The camera did not answer', { cause });
    });
    const body = await response.text();
    // VAPIX says some failures in the body of a `200`, as an `Error:` line.
    const refusal = /^#?\s*Error:?\s*(.*)$/imu.exec(body);
    if (!response.ok || refusal !== null) throw new Refused(response.status, refusal?.[1] ?? body);
    return parseLines(body);
  }
}

/** The camera answered, and refused what it was asked. */
class Refused extends CameraFailure {
  constructor(status: number, detail: string) {
    super(`The camera refused: HTTP ${status} ${detail.trim().slice(0, 200)}`.trim());
    this.name = 'Refused';
  }
}

/** The axis's range, for a command that needs it. */
function required(range: Range | undefined, axis: string): Range {
  if (range === undefined) throw new UnsupportedCommand(axis);
  return range;
}

/** The picture `center` and `areazoom` coordinates are in. */
function pictureParameters(): URLSearchParams {
  return new URLSearchParams({ imagewidth: String(PICTURE.width), imageheight: String(PICTURE.height) });
}

/** What `query=position` reported, in the contract's units, on the axes the camera has. */
function positionOf(reported: Map<string, string>, limits: Limits): CameraPosition {
  const position: CameraPosition = {};
  const pan = Number(reported.get('pan'));
  const tilt = Number(reported.get('tilt'));
  const zoom = Number(reported.get('zoom'));
  const focus = Number(reported.get('focus'));
  if (limits.pan !== undefined && Number.isFinite(pan)) position.pan = pan;
  if (limits.tilt !== undefined && Number.isFinite(tilt)) position.tilt = tilt;
  if (limits.zoom !== undefined && Number.isFinite(zoom)) position.zoom = toFraction(zoom, limits.zoom);
  if (limits.focus !== undefined && Number.isFinite(focus)) position.focus = toFraction(focus, limits.focus);
  return position;
}
