import { index, layout, route, type RouteConfig } from '@react-router/dev/routes';

export default [
  layout('./routes/app-layout.tsx', [index('./routes/home.tsx')]),
  route('sign-in', './routes/sign-in.tsx'),
  route('device', './routes/device.tsx'),
  route('account', './routes/account.tsx'),
  route('about', './routes/about.tsx'),
  route('sidebar-07', './routes/sidebar-07.tsx'),
  route('sidebar-09', './routes/sidebar-09.tsx'),
  route('sidebar-16', './routes/sidebar-16.tsx'),
  route('*', './routes/not-found.tsx')
] satisfies RouteConfig;
