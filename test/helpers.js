// Shared by the tests that run the real server.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Runs server.js from a temp directory, so serverconfig/ is a temp folder. setup(configDir)
// runs first, to plant files; env adds environment variables. Everything the server logs is
// kept, for checking.
export async function startServer(setup, env = {}) {
    const workDir = await mkdtemp(path.join(tmpdir(), 'jembex-'));
    const configDir = path.join(workDir, 'serverconfig');
    await setup?.(configDir);

    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        cwd: workDir, env: { ...process.env, ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout.on('data', d => { logs += d; });
    child.stderr.on('data', d => { logs += d; });

    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
        try {
            if ((await fetch(`${url}/health`)).ok) {
                return {
                    url, port, configDir,
                    logs: () => logs,
                    async stop() {
                        child.kill();
                        await rm(workDir, { recursive: true, force: true });
                    },
                };
            }
        } catch { /* starting */ }
        await new Promise(r => setTimeout(r, 100));
    }
    child.kill();
    throw new Error(`server did not start:\n${logs}`);
}

// Sends request text exactly as written, which fetch() won't do: it cleans up "/../" and
// refuses odd request lines. Resolves to { status, headers, body }.
export function rawRequest(port, text) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
        let data = '';
        socket.setEncoding('latin1');
        socket.on('data', chunk => { data += chunk; });
        socket.on('error', reject);
        socket.on('end', () => {
            const [head, ...rest] = data.split('\r\n\r\n');
            const [statusLine, ...lines] = head.split('\r\n');
            const headers = Object.fromEntries(lines.map(line => {
                const i = line.indexOf(':');
                return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()];
            }));
            resolve({ status: Number(statusLine.split(' ')[1]), headers, body: rest.join('\r\n\r\n') });
        });
    });
}

export const get = (port, target, extra = '') =>
    rawRequest(port, `GET ${target} HTTP/1.1\r\nHost: localhost\r\n${extra}Connection: close\r\n\r\n`);
