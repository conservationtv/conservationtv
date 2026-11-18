import { connect as dial } from 'node:net';

/** Whether something accepts TCP connections at `port` on loopback. */
export function listening(port: number, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const socket = dial({ host: '127.0.0.1', port, signal });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}
