import { Readable } from 'node:stream';
import { StreamableFile } from '@nestjs/common';
import { cutOnFailure } from './submissions-admin.controller';

function response(headersSent: boolean) {
  return {
    destroyed: false,
    headersSent,
    statusCode: 200,
    send: jest.fn(),
    end: jest.fn(),
    destroy: jest.fn(),
  };
}

describe('cutOnFailure', () => {
  const failure = new Error('database gone');

  it('cuts the connection when the body was already under way, instead of ending it normally', () => {
    const file = cutOnFailure(new StreamableFile(Readable.from([])));
    const res = response(true);
    file.errorHandler(failure, res);
    expect(res.destroy).toHaveBeenCalledWith(failure);
    expect(res.end).not.toHaveBeenCalled();
  });

  it("leaves a failure before the headers to Nest's own handler", () => {
    const file = cutOnFailure(new StreamableFile(Readable.from([])));
    const res = response(false);
    file.errorHandler(failure, res);
    expect(res.destroy).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalled();
  });
});
