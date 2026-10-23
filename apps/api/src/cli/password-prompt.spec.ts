import { PassThrough } from 'node:stream';
import { type PasswordInput, readNewPassword } from './password-prompt';

/** A stand-in for a terminal's stdin: raw mode is recorded, typed keys are pushed in. */
function terminal(): PassThrough & PasswordInput & { raw: boolean[] } {
  const input = new PassThrough() as PassThrough & PasswordInput & { raw: boolean[] };
  input.isTTY = true;
  input.raw = [];
  input.setRawMode = (mode: boolean) => input.raw.push(mode);
  return input;
}

function collect(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('readNewPassword (admin:create)', () => {
  it('takes the first line of piped input', async () => {
    const input = new PassThrough();
    input.end('piped-password-1\r\nsecond line\r\n');
    expect(await readNewPassword(input, collect().stream)).toBe('piped-password-1');
  });

  it('refuses empty piped input', async () => {
    const input = new PassThrough();
    input.end('');
    await expect(readNewPassword(input, collect().stream)).rejects.toThrow(
      'No password on standard input',
    );
  });

  it('asks twice in a terminal with echo off, handles backspace, and never shows the password', async () => {
    const input = terminal();
    const out = collect();
    const result = readNewPassword(input, out.stream);
    await tick();
    input.write('secret-pass');
    input.write('x\u007f');
    input.write('word\r');
    await tick();
    input.write('secret-password\r');
    expect(await result).toBe('secret-password');
    expect(input.raw).toEqual([true, false, true, false]);
    expect(out.text()).toBe('Password: \nRepeat password: \n');
  });

  it('refuses two different passwords', async () => {
    const input = terminal();
    const result = readNewPassword(input, collect().stream);
    await tick();
    input.write('secret-password\r');
    await tick();
    input.write('secret-passwore\r');
    await expect(result).rejects.toThrow('The two passwords differ; nothing changed');
  });

  it('stops on Ctrl+C and leaves raw mode', async () => {
    const input = terminal();
    const result = readNewPassword(input, collect().stream);
    await tick();
    input.write('secr\u0003');
    await expect(result).rejects.toThrow('Cancelled; nothing changed');
    expect(input.raw).toEqual([true, false]);
  });
});
