import { z } from 'zod';

// Form inputs, validated in the browser before anything is sent. Limits mirror the studio API's own validation.

export const EmailSchema = z.object({
  email: z.email('Enter an email address.')
});
export type Email = z.output<typeof EmailSchema>;
export type EmailInput = z.input<typeof EmailSchema>;

export const CodeSchema = z.object({
  otp: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code from your email.')
});
export type Code = z.output<typeof CodeSchema>;
export type CodeInput = z.input<typeof CodeSchema>;

export const AccountNameSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(120, 'Use 120 characters or fewer.')
});
export type AccountName = z.output<typeof AccountNameSchema>;
export type AccountNameInput = z.input<typeof AccountNameSchema>;

export const PasskeyNameSchema = z.object({
  name: z.string().trim().max(64, 'Use 64 characters or fewer.')
});
export type PasskeyName = z.output<typeof PasskeyNameSchema>;
export type PasskeyNameInput = z.input<typeof PasskeyNameSchema>;

export const DeviceCodeSchema = z.object({
  userCode: z
    .string()
    .trim()
    .min(1, 'Enter the code the device shows.')
    .transform(code => code.toUpperCase().replace(/[\s-]/g, ''))
});
export type DeviceCode = z.output<typeof DeviceCodeSchema>;
export type DeviceCodeInput = z.input<typeof DeviceCodeSchema>;

export const RtmpChannelSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(120, 'Use 120 characters or fewer.'),
  url: z
    .string()
    .trim()
    .regex(/^rtmps?:\/\/[^\s/]+\/\S+$/u, 'Enter an rtmp:// or rtmps:// server URL, with its application.'),
  key: z.string().trim().min(1, 'Enter the stream key.').max(512, 'Use 512 characters or fewer.')
});
export type RtmpChannel = z.output<typeof RtmpChannelSchema>;
export type RtmpChannelInput = z.input<typeof RtmpChannelSchema>;

/** A name for anything an organisation names: a network, an agent, a camera, a gateway, a stream. */
export const NameSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(120, 'Use 120 characters or fewer.')
});
export type Name = z.output<typeof NameSchema>;
export type NameInput = z.input<typeof NameSchema>;

/** An agent: its name, the network it is on, and its priority among that network's agents, typed as text. */
export const NewAgentSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(120, 'Use 120 characters or fewer.'),
  networkId: z.uuid('Choose a network.'),
  priority: z
    .string()
    .trim()
    .regex(/^-?\d+$/, 'Enter a whole number.')
    .transform(Number)
    .pipe(z.number().min(-1000, 'Use -1000 or more.').max(1000, 'Use 1000 or fewer.'))
});
export type NewAgent = z.output<typeof NewAgentSchema>;
export type NewAgentInput = z.input<typeof NewAgentSchema>;

/** The name an account goes by in one organisation, as its members see it. */
export const DisplayNameSchema = z.object({
  displayName: z.string().trim().min(1, 'Enter a name.').max(120, 'Use 120 characters or fewer.')
});
export type DisplayName = z.output<typeof DisplayNameSchema>;
export type DisplayNameInput = z.input<typeof DisplayNameSchema>;

/** A new organisation: its name, and the name its creator goes by there. */
export const NewOrganisationSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(120, 'Use 120 characters or fewer.'),
  displayName: z.string().trim().min(1, 'Enter a name.').max(120, 'Use 120 characters or fewer.')
});
export type NewOrganisation = z.output<typeof NewOrganisationSchema>;
export type NewOrganisationInput = z.input<typeof NewOrganisationSchema>;

/** Who an invitation is sent to: an email address, which is sent its link. */
export const InvitationEmailSchema = z.object({
  email: z.email('Enter an email address.').max(320, 'Use 320 characters or fewer.')
});
export type InvitationEmail = z.output<typeof InvitationEmailSchema>;
export type InvitationEmailInput = z.input<typeof InvitationEmailSchema>;

/** What an agent's own page edits: its device's name, and its priority. Its network never changes. */
export const AgentSettingsSchema = NewAgentSchema.pick({ name: true, priority: true });
export type AgentSettings = z.output<typeof AgentSettingsSchema>;
export type AgentSettingsInput = z.input<typeof AgentSettingsSchema>;

/** A network chosen from a select: the empty choice is the internet, which the API names `null`. */
const NetworkChoiceSchema = z.string().transform(networkId => networkId || null);
export type NetworkChoice = z.output<typeof NetworkChoiceSchema>;

/** A device's name and network, as administrators change them whatever its kind. */
export const DeviceDetailsSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(120, 'Use 120 characters or fewer.'),
  networkId: NetworkChoiceSchema
});
export type DeviceDetails = z.output<typeof DeviceDetailsSchema>;
export type DeviceDetailsInput = z.input<typeof DeviceDetailsSchema>;

/** The resolutions an Axis camera streams, as VAPIX lists them, typed as one list: "1280x720, 640x360". */
const CameraResolutionsSchema = z
  .string()
  .trim()
  .regex(/^\d{2,5}x\d{2,5}(?:[\s,]+\d{2,5}x\d{2,5})*$/u, 'List the resolutions it streams, such as 1280x720, 640x360.')
  .transform(list => list.split(/[\s,]+/u));
export type CameraResolutions = z.output<typeof CameraResolutionsSchema>;

/** An Axis camera's RTSP port, typed as text: empty for its default, 554. */
const CameraRtspPortSchema = z
  .string()
  .trim()
  .regex(/^\d{0,5}$/u, 'Enter a port number, or leave it empty for 554.')
  .transform(port => (port === '' ? undefined : Number(port)))
  .pipe(z.int().min(1, 'Use a port from 1 to 65535.').max(65_535, 'Use a port from 1 to 65535.').optional());
export type CameraRtspPort = z.output<typeof CameraRtspPortSchema>;

// A camera's settings are a choice of driver, each reading its own fields. The form keeps every driver's fields as
// typed, so switching back and forth keeps them; the chosen driver then checks only its own and ignores the rest.

/** Every driver's fields, as the form holds them. */
const CameraFormFieldsSchema = z.object({
  driver: z.enum(['axis', 'rtsp']),
  host: z.string(),
  rtspPort: z.string(),
  resolutions: z.string(),
  url: z.string()
});
export type CameraFormFields = z.output<typeof CameraFormFieldsSchema>;

/** An Axis camera: its web server's address, its RTSP port, and the resolutions it streams. */
const AxisCameraFieldsSchema = z.object({
  driver: z.literal('axis'),
  host: z
    .string()
    .trim()
    .pipe(z.url({ protocol: /^https?$/u, error: 'Enter its web address, such as http://192.168.1.10.' })),
  rtspPort: CameraRtspPortSchema,
  resolutions: CameraResolutionsSchema,
  url: z.string()
});
type AxisCameraFields = z.output<typeof AxisCameraFieldsSchema>;

/** Any camera with one RTSP stream: its URL, without the credentials, which are kept apart and never shown. */
const RtspCameraFieldsSchema = z.object({
  driver: z.literal('rtsp'),
  host: z.string(),
  rtspPort: z.string(),
  resolutions: z.string(),
  url: z
    .string()
    .trim()
    .pipe(z.url({ error: 'Enter its stream’s URL, such as rtsp://192.168.1.10:554/stream.' }))
    .refine(
      url => !/^[a-z][a-z\d+.-]*:\/\/[^/]*@/iu.test(url),
      'Leave the username and password out: they’re kept apart, as its credentials.'
    )
});
type RtspCameraFields = z.output<typeof RtspCameraFieldsSchema>;

/** The settings the API keeps for a camera, from its driver's fields. */
function cameraSettingsOf(fields: AxisCameraFields | RtspCameraFields) {
  if (fields.driver === 'rtsp') return { driver: fields.driver, url: fields.url };
  return { driver: fields.driver, host: fields.host, rtspPort: fields.rtspPort, resolutions: fields.resolutions };
}

/** How a camera is reached, as its settings page edits them: replaced whole. */
export const CameraSettingsSchema = CameraFormFieldsSchema.pipe(
  z.discriminatedUnion('driver', [AxisCameraFieldsSchema, RtspCameraFieldsSchema])
).transform(cameraSettingsOf);
export type CameraSettings = z.output<typeof CameraSettingsSchema>;
export type CameraSettingsInput = z.input<typeof CameraSettingsSchema>;

/** A camera's username and password. Write-only: they replace what is kept, which is never read back. */
export const CameraCredentialsSchema = z.object({
  username: z.string().trim().min(1, 'Enter the username.').max(120, 'Use 120 characters or fewer.'),
  password: z.string().max(256, 'Use 256 characters or fewer.')
});
export type CameraCredentials = z.output<typeof CameraCredentialsSchema>;
export type CameraCredentialsInput = z.input<typeof CameraCredentialsSchema>;

/** Whether a camera feeds its streams: only an enabled one does. */
const CameraStateSchema = z.enum(['enabled', 'locked', 'disabled']);
export type CameraState = z.output<typeof CameraStateSchema>;

/** What a new camera has beside its driver's fields: its name, network, optional credentials and state. */
const NEW_CAMERA_DETAILS = {
  name: z.string().trim().min(1, 'Enter a name.').max(120, 'Use 120 characters or fewer.'),
  networkId: NetworkChoiceSchema,
  username: z.string().trim().max(120, 'Use 120 characters or fewer.'),
  password: z.string().max(256, 'Use 256 characters or fewer.'),
  state: CameraStateSchema
};

/** A new camera's fields, as the form holds them. */
const NewCameraFormFieldsSchema = CameraFormFieldsSchema.extend({
  name: z.string(),
  networkId: z.string(),
  username: z.string(),
  password: z.string(),
  state: CameraStateSchema
});
export type NewCameraFormFields = z.output<typeof NewCameraFormFieldsSchema>;

/** The credentials a new camera is made with: none when no username is given. */
function newCameraCredentialsOf(username: string, password: string) {
  return username === '' ? undefined : { username, password };
}

/** A new camera, as the API takes it: the driver's fields become its settings, a username and password its credentials. */
export const NewCameraSchema = NewCameraFormFieldsSchema.pipe(
  z.discriminatedUnion('driver', [
    AxisCameraFieldsSchema.extend(NEW_CAMERA_DETAILS),
    RtspCameraFieldsSchema.extend(NEW_CAMERA_DETAILS)
  ])
)
  .refine(camera => camera.username !== '' || camera.password === '', {
    path: ['username'],
    error: 'Enter the username that goes with the password.'
  })
  .transform(camera => ({
    name: camera.name,
    networkId: camera.networkId,
    settings: cameraSettingsOf(camera),
    credentials: newCameraCredentialsOf(camera.username, camera.password),
    state: camera.state
  }));
export type NewCamera = z.output<typeof NewCameraSchema>;
export type NewCameraInput = z.input<typeof NewCameraSchema>;

/** A URL in place of the one a MediaMTX gateway's agent registers for a protocol, with that protocol's schemes. */
function gatewayUrlOverride(schemes: readonly string[], example: string) {
  return z
    .string()
    .trim()
    .refine(
      url => url === '' || (URL.canParse(url) && schemes.includes(new URL(url).protocol)),
      `Enter a URL such as ${example}, or leave it empty.`
    );
}

/** A MediaMTX gateway's URL overrides by protocol, each empty to use what its agent registers. */
const GatewayUrlsSchema = z.object({
  webrtc: gatewayUrlOverride(['http:', 'https:'], 'https://hide.example.org:8889'),
  rtsp: gatewayUrlOverride(['rtsp:'], 'rtsp://hide.example.org:8554'),
  rtsps: gatewayUrlOverride(['rtsps:'], 'rtsps://hide.example.org:8322'),
  rtmp: gatewayUrlOverride(['rtmp:'], 'rtmp://hide.example.org:1935'),
  rtmps: gatewayUrlOverride(['rtmps:'], 'rtmps://hide.example.org:1936'),
  hls: gatewayUrlOverride(['http:', 'https:'], 'https://hide.example.org:8888')
});
export type GatewayUrls = z.output<typeof GatewayUrlsSchema>;

/** A MediaMTX gateway: its name, its network, and the URL overrides its settings keep, only those given. */
export const GatewaySchema = z
  .object({
    name: z.string().trim().min(1, 'Enter a name.').max(120, 'Use 120 characters or fewer.'),
    networkId: NetworkChoiceSchema,
    urls: GatewayUrlsSchema
  })
  .transform(({ name, networkId, urls }) => ({
    name,
    networkId,
    settings: { urls: Object.fromEntries(Object.entries(urls).filter(([, url]) => url !== '')) }
  }));
export type Gateway = z.output<typeof GatewaySchema>;
export type GatewayInput = z.input<typeof GatewaySchema>;

/** The qualities a stream is delivered at, as the API names them (apps/studio/api/src/topology/settings.ts). */
const RenditionSchema = z.enum(['default', 'data_saver', 'balanced', 'quality']);
export type Rendition = z.output<typeof RenditionSchema>;

/** The renditions an exposure offers: at least one. */
const OfferedRenditionsSchema = z.array(RenditionSchema).min(1, 'Offer at least one rendition.');
export type OfferedRenditions = z.output<typeof OfferedRenditionsSchema>;

/**
 * Delivering a stream to a gateway: what feeds it (another of the stream's exposures, or the empty string for its
 * source), the renditions it offers, and the device pinned to publish it (the empty string to let the system choose).
 */
export const ExposureSchema = z.object({
  gatewayId: z.string().min(1, 'Choose a gateway.'),
  upstreamExposureId: z.string().transform(id => id || null),
  renditions: OfferedRenditionsSchema,
  publisherDeviceId: z.string().transform(id => id || null)
});
export type Exposure = z.output<typeof ExposureSchema>;
export type ExposureInput = z.input<typeof ExposureSchema>;

/** Recording one of a stream's exposures, at one of the renditions it offers, by a kind of recorder. */
export const RecorderSchema = z.object({
  exposureId: z.string().min(1, 'Choose a delivery to record.'),
  rendition: RenditionSchema,
  kind: z.string().trim().min(1, 'Enter the kind of recorder.').max(60, 'Use 60 characters or fewer.')
});
export type Recorder = z.output<typeof RecorderSchema>;
export type RecorderInput = z.input<typeof RecorderSchema>;

/** Where a new stream comes from: a camera, or whatever publishes to it. */
export const StreamSourceSchema = z.enum(['camera', 'publisher']);
export type StreamSource = z.output<typeof StreamSourceSchema>;

/**
 * A new stream: its name; its source, a camera or whatever publishes it (with the device pinned to, or the empty
 * string for none yet); and the gateways it is delivered to from the start, each with the renditions it offers.
 */
export const NewStreamSchema = NameSchema.extend({
  source: StreamSourceSchema,
  cameraId: z.string(),
  publisherDeviceId: z.string().transform(id => id || null),
  deliveries: z.array(z.object({ gatewayId: z.string(), renditions: OfferedRenditionsSchema }))
}).refine(stream => stream.source !== 'camera' || stream.cameraId !== '', {
  message: 'Choose a camera.',
  path: ['cameraId']
});
export type NewStream = z.output<typeof NewStreamSchema>;
export type NewStreamInput = z.input<typeof NewStreamSchema>;

/** A resolution chosen as `<width>x<height>`, both even, within what a show's programme may be. */
const ResolutionSchema = z
  .string()
  .regex(/^\d{2,4}x\d{2,4}$/u, 'Choose a resolution.')
  .transform(resolution => {
    const [width = 0, height = 0] = resolution.split('x').map(Number);
    return { width, height };
  })
  .pipe(
    z.object({
      width: z.int().min(160).max(3840).multipleOf(2, 'Use an even width.'),
      height: z.int().min(90).max(2160).multipleOf(2, 'Use an even height.')
    })
  );
export type Resolution = z.output<typeof ResolutionSchema>;

/**
 * How a show's programme is encoded, chosen as text: its resolution, frame rate, constant bitrate in kbps and keyframe
 * interval in seconds, within the API's limits.
 */
export const EncodingSchema = z
  .object({
    resolution: ResolutionSchema,
    fps: z
      .string()
      .regex(/^\d+$/u, 'Choose a frame rate.')
      .transform(Number)
      .pipe(z.int().min(1, 'Use 1 to 60 frames a second.').max(60, 'Use 1 to 60 frames a second.')),
    bitrateKbps: z
      .string()
      .trim()
      .regex(/^\d+$/u, 'Enter a whole number of kbps.')
      .transform(Number)
      .pipe(z.int().min(500, 'Use 500 kbps or more.').max(50_000, 'Use 50000 kbps or fewer.')),
    keyframeSeconds: z
      .string()
      .regex(/^\d+$/u, 'Choose a keyframe interval.')
      .transform(Number)
      .pipe(z.int().min(1, 'Use 1 to 10 seconds.').max(10, 'Use 1 to 10 seconds.'))
  })
  .transform(({ resolution, ...rest }) => ({ ...resolution, ...rest }));
export type Encoding = z.output<typeof EncodingSchema>;
export type EncodingInput = z.input<typeof EncodingSchema>;
