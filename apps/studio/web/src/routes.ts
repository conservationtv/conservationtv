import { index, layout, route, type RouteConfig } from '@react-router/dev/routes';

export default [
  // The public homepage: what conservation.tv is, with a way into the app.
  index('./routes/about.tsx'),
  // Everything under this layout is signed in: it checks the session once, before rendering any of it.
  layout('./routes/authenticated-layout.tsx', [
    // The app's rail, around everything that lives in the app.
    layout('./routes/app-layout.tsx', [
      // Pages that aren't in an organisation scroll as one page in the app's pane.
      layout('./routes/page-layout.tsx', [
        route('organisations', './routes/home.tsx'),
        route('organisations/new', './routes/organisation-new.tsx'),
        // The signed-in account: its profile, how it signs in, and the organisations it is in or invited to.
        route('account', './routes/account.tsx')
      ]),
      // An organisation's section sidebar, around its pages: everything under it is in that organisation.
      route('organisations/:organisationId', './routes/organisation-layout.tsx', [
        index('./routes/organisation-home.tsx'),
        route('streams', './routes/streams.tsx'),
        route('streams/new', './routes/stream-new.tsx', [
          // Adding a camera without leaving the new stream's form, which then chooses it.
          route('camera', './routes/stream-new-camera.tsx')
        ]),
        route('streams/:streamId', './routes/stream.tsx'),
        // The organisation's broadcast, composed by the studio API and followed live.
        route('show', './routes/show.tsx'),
        // Where the broadcast goes out to: Twitch channels and RTMP destinations.
        route('channels', './routes/channels.tsx', [route('rtmp/new', './routes/channel-rtmp-new.tsx')]),
        // What the streams run on: the sites, and the agents, cameras and gateways on them.
        // Adding one is a dialog routed over its list, at `new`, so it can be linked to.
        route('networks', './routes/networks.tsx', [route('new', './routes/network-new.tsx')]),
        route('agents', './routes/agents.tsx', [route('new', './routes/agent-new.tsx')]),
        route('agents/:agentId', './routes/agent.tsx'),
        route('cameras', './routes/cameras.tsx', [route('new', './routes/camera-new.tsx')]),
        route('cameras/:cameraId', './routes/camera.tsx'),
        route('gateways', './routes/gateways.tsx', [route('new', './routes/gateway-new.tsx')]),
        route('publishers', './routes/publishers.tsx'),
        route('devices', './routes/devices.tsx'),
        // The organisation itself, under its own tabs.
        route('settings', './routes/settings-layout.tsx', [
          index('./routes/settings-general.tsx'),
          route('members', './routes/settings-members.tsx', [route('invite', './routes/settings-members-invite.tsx')]),
          route('roles', './routes/settings-roles.tsx')
        ])
      ])
    ]),
    // The page an emailed invitation's link opens, carrying its one-time code.
    route('invitations/:invitationId', './routes/invitation.tsx')
  ]),
  route('sign-in', './routes/sign-in.tsx'),
  route('device', './routes/device.tsx'),
  route('*', './routes/not-found.tsx')
] satisfies RouteConfig;
