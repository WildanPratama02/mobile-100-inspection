import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiProblem } from './problem';

/** What body-parser passes on for a bad body: `entity.parse.failed`, `entity.too.large`, … */
interface BodyParserError {
  type?: unknown;
  status?: unknown;
}

/**
 * Turns every error into `application/problem+json` with a code of doc 04 §6, so no client ever sees HTML or
 * Nest's own error shape. Anything unexpected becomes `500 INTERNAL`; its stack goes to the log, never to the
 * client.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const problem = this.toProblem(exception);
    if (problem.code === 'INTERNAL') {
      this.logger.error(
        { err: exception, reqId: req.id, method: req.method, url: req.originalUrl },
        'Unhandled error',
      );
    }
    if (problem.retryAfter !== undefined) res.setHeader('Retry-After', String(problem.retryAfter));
    res
      .status(problem.body.status)
      .type('application/problem+json')
      .send(JSON.stringify(problem.body));
  }

  private toProblem(exception: unknown): ApiProblem {
    if (exception instanceof ApiProblem) return exception;
    // body-parser's size error reaches the filter as is.
    if ((exception as BodyParserError)?.type === 'entity.too.large') {
      return new ApiProblem('PAYLOAD_TOO_LARGE');
    }
    if (exception instanceof HttpException) {
      switch (exception.getStatus()) {
        case 404:
          return new ApiProblem('NOT_FOUND');
        case 413:
          return new ApiProblem('PAYLOAD_TOO_LARGE');
        case 400:
          return malformed(exception.message);
        case 429:
          return new ApiProblem('RATE_LIMITED');
      }
    }
    return new ApiProblem('INTERNAL');
  }
}

/**
 * Nest answers a body that is not JSON, or a path with broken %-encoding, with 400. Doc 04 has no 400: such a
 * request can never succeed as sent, which is `422 VALIDATION_FAILED`.
 */
function malformed(message: string): ApiProblem {
  return new ApiProblem('VALIDATION_FAILED', {
    detail: 'Data tidak lengkap: request tidak dapat dibaca.',
    errors: [{ path: '', code: 'MALFORMED_REQUEST', message }],
  });
}
