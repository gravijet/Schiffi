/**
 * Development runner.
 *
 * Starts the game server and the Vite dev server together and prefixes both
 * output streams, so `npm run dev` is the only command needed. Vite proxies
 * /api and /ws to the game server, so the client is reached on one origin.
 */
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ESC = String.fromCharCode(27);
const colour = (code, text) => `${ESC}[${code}m${text}${ESC}[0m`;

const processes = [];

function run(name, command, args, code) {
  const child = spawn(command, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `${colour(code, `[${name}]`)} `;

  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) process.stdout.write(`${prefix}${line}\n`);
    });
  }

  child.on('exit', (exitCode) => {
    process.stdout.write(`${prefix}exited with code ${exitCode}\n`);
    shutdown(exitCode ?? 0);
  });
  processes.push(child);
  return child;
}

function shutdown(exitCode = 0) {
  for (const child of processes) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('server', process.execPath, ['--experimental-sqlite', '--watch', 'server/src/index.js'], '36');
run('client', process.execPath, [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--host'], '33');

console.log('\nSchiffi development servers starting.');
console.log('  client  http://localhost:5173');
console.log('  api     http://localhost:8080\n');
