import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';

const root = dirname(fileURLToPath(import.meta.url));
const entry = join(root, 'server.mjs');
const directory = join(root, '../data/tracker');
const registry = join(directory, 'server-process.json');
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (existsSync(registry)) {
  const previous = JSON.parse(readFileSync(registry, 'utf8'));
  if (Number.isSafeInteger(previous.pid) && previous.pid > 1 && previous.entry === entry) {
    const command = spawnSync('ps', ['-p', String(previous.pid), '-o', 'command='], { encoding: 'utf8' }).stdout.trim();
    if (command === `${previous.node} ${entry}`) {
      console.log('正在重启本项目登记的台账服务，不处理其他应用。');
      process.kill(previous.pid, 'SIGTERM');
      for (let n = 0; n < 30; n++) {
        try { process.kill(previous.pid, 0); } catch { break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } else if (command) throw new Error('登记 PID 已属于其他进程，未结束它；请检查后再启动');
  }
}
const port = Number(process.env.PORT || 4319);
await new Promise((resolve, reject) => {
  const check = createServer(); check.once('error', () => reject(new Error(`端口 ${port} 被其他或未登记的服务占用，未自动结束它。`)));
  check.listen(port, '127.0.0.1', () => check.close(resolve));
});
const child = spawn(process.execPath, [entry], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: 'inherit' });
child.once('error', () => { console.error('台账服务启动失败'); process.exitCode = 1; });
child.once('spawn', () => writeFileSync(registry, JSON.stringify({ pid: child.pid, node: process.execPath, entry, port }), { mode: 0o600 }));
child.once('exit', (code, signal) => { process.exitCode = signal === 'SIGTERM' ? 0 : code || 0; });
