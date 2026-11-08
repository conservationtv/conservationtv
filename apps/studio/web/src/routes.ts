import { index, layout, prefix, route, type RouteConfig } from '@react-router/dev/routes';

export default [
  // The public homepage: what conservation.tv is, with a way into the app.
  index('./routes/about.tsx'),
  // Everything under this layout is signed in: it checks the session once, before rendering any of it.
  layout('./routes/authenticated-layout.tsx', [
    // The app's rail, around everything that lives in the app.
    layout('./routes/app-layout.tsx', [
      ...prefix('organisations', [
        index('./routes/home.tsx'),
        // An organisation's section sidebar, around its pages: everything under it is in that organisation.
        route(':organisationId', './routes/organisation-layout.tsx', [
          index('./routes/organisation-home.tsx'),
          route('streams', './routes/streams.tsx'),
          // The organisation's broadcast, composed by the studio API and followed live.
          route('show', './routes/show.tsx'),
          // Where the broadcast goes out to: Twitch channels and RTMP destinations.
          route('channels', './routes/channels.tsx')
        ])
      ])
    ]),
    route('account', './routes/account.tsx')
  ]),
  route('sign-in', './routes/sign-in.tsx'),
  route('device', './routes/device.tsx'),
  route('*', './routes/not-found.tsx')
] satisfies RouteConfig;
