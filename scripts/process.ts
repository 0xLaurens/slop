import { spawn } from 'node:child_process';

export type Run = (command: string, args: readonly string[], cwd: string) => Promise<string>;

// Never use a shell: imported paths, refs, and item names are arguments, not code.
export const run: Run = (command, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-1024 * 1024); });
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16384); });
  child.once('error', (error) => reject(new Error(`Cannot run ${command}. Install it and make it available on PATH. ${error.message}`)));
  child.once('close', (code, signal) => code === 0 ? resolve(stdout.trim())
    : reject(new Error(`${command} ${args.join(' ')} failed (${code ?? signal}): ${stderr || stdout}`)));
});
