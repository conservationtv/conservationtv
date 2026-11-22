import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CHANNELS, type DesktopBridge, type DesktopState, type LogLine } from '../shared/bridge.ts';

// The renderer's only way to the main process: the bridge's calls, each one IPC channel (src/shared/bridge.ts).

function listen<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const bridge: DesktopBridge = {
  state: () => ipcRenderer.invoke(CHANNELS.state),
  onState: listener => listen<DesktopState>(CHANNELS.stateChanged, listener),
  logs: () => ipcRenderer.invoke(CHANNELS.logs),
  onLog: listener => listen<LogLine>(CHANNELS.logged, listener),
  start: () => ipcRenderer.invoke(CHANNELS.start),
  stop: () => ipcRenderer.invoke(CHANNELS.stop),
  forget: () => ipcRenderer.invoke(CHANNELS.forget),
  openDataFolder: () => ipcRenderer.invoke(CHANNELS.openDataFolder),
  openLogFolder: () => ipcRenderer.invoke(CHANNELS.openLogFolder)
};

contextBridge.exposeInMainWorld('desktop', bridge);
