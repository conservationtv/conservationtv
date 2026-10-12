import dedent from 'dedent';
import { sanitizeName } from '../naming';

export function composeUnit(description: string, dir: string, services: readonly string[]): string {
  if (!dir.startsWith('/')) throw new Error('Compose directory must be absolute.');
  const serviceList = services.map(service => shellQuote(sanitizeName(service))).join(' ');
  return dedent`
    [Unit]
    Description=${description}
    After=docker.service network-online.target
    Wants=network-online.target
    Requires=docker.service

    [Service]
    Type=oneshot
    RemainAfterExit=yes
    WorkingDirectory=${dir}
    ExecStartPre=/usr/bin/docker compose -f ${dir}/docker-compose.yml pull ${serviceList}
    ExecStart=/usr/bin/docker compose -f ${dir}/docker-compose.yml up -d --remove-orphans ${serviceList}
    ExecStop=/usr/bin/docker compose -f ${dir}/docker-compose.yml stop ${serviceList}
    TimeoutStartSec=0

    [Install]
    WantedBy=multi-user.target
  `;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
