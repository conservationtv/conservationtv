import { index, layout, route, type RouteConfig } from '@react-router/dev/routes';

export default [
  // Everything under this layout is signed in: it checks the session once, before rendering any of it.
  layout('./routes/authenticated-layout.tsx', [
    // The app's rail, around everything that lives in the app.
    layout('./routes/app-layout.tsx', [
      index('./routes/home.tsx'),
      // An organisation's section sidebar, around its pages: everything under it is in that organisation.
      route('organisations/:organisationId', './routes/organisation-layout.tsx', [
        index('./routes/organisation-home.tsx'),
        route('streams', './routes/streams.tsx')
      ])
    ]),
    route('account', './routes/account.tsx')
  ]),
  route('sign-in', './routes/sign-in.tsx'),
  route('device', './routes/device.tsx'),
  route('about', './routes/about.tsx'),
  route('sidebar-07', './routes/sidebar-07.tsx'),
  route('sidebar-09', './routes/sidebar-09.tsx'),
  route('sidebar-16', './routes/sidebar-16.tsx'),
  route('*', './routes/not-found.tsx')
] satisfies RouteConfig;
