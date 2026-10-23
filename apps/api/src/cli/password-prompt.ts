/**
 * Reads a new admin password for `admin:create` without showing it: typed twice at a hidden prompt in a
 * terminal, or the first line of standard input when it is not a terminal (piped from a password manager).
 * The password is never written anywhere.
 */
import type { Writable } from 'node:stream';

/** What the prompt needs of `process.stdin`. */
export interface PasswordInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

export class PasswordInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordInputError';
  }
}

export async function readNewPassword(
  input: PasswordInput = process.stdin,
  output: Writable = process.stderr,
): Promise<string> {
  if (!input.isTTY || !input.setRawMode) {
    const password = await readFirstLine(input);
    if (!password) throw new PasswordInputError('No password on standard input');
    return password;
  }
  const password = await readHidden(input, output, 'Password: ');
  const repeated = await readHidden(input, output, 'Repeat password: ');
  if (password !== repeated)
    throw new PasswordInputError('The two passwords differ; nothing changed');
  return password;
}

function readHidden(input: PasswordInput, output: Writable, prompt: string): Promise<string> {
  output.write(prompt);
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => {
      input.removeListener('data', onData);
      input.setRawMode!(false);
      input.pause();
      output.write('\n');
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString()) {
        if (ch === '\r' || ch === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          finish();
          reject(new PasswordInputError('Cancelled; nothing changed'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = [...value].slice(0, -1).join('');
        else if (ch >= ' ') value += ch;
      }
    };
    input.setRawMode!(true);
    input.on('data', onData);
    input.resume();
  });
}

async function readFirstLine(input: PasswordInput): Promise<string> {
  let text = '';
  for await (const chunk of input) {
    text += chunk.toString();
    if (/\r?\n/.test(text)) break;
  }
  return text.split(/\r?\n/)[0] ?? '';
}
