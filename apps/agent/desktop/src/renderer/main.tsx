import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@conservationtv/ui/globals.css';
import { App } from './app.tsx';

// The UI kit's dark theme is the `dark` class on the root: follow the system's appearance.
const dark = window.matchMedia('(prefers-color-scheme: dark)');
const followAppearance = () => document.documentElement.classList.toggle('dark', dark.matches);
followAppearance();
dark.addEventListener('change', followAppearance);

const root = document.getElementById('root');
if (root === null) throw new Error('The page has no #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
