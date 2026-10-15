import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionResponse = exception instanceof HttpException ? exception.getResponse() : null;

    const message = this.extractMessage(exception, exceptionResponse);
    const error = exception instanceof HttpException ? exception.name : 'InternalServerError';

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    // Quota/rate-limit exceptions know when retrying makes sense; tell the client.
    const retryAfter = (exception as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
    if (typeof retryAfter === 'number' && retryAfter > 0) {
      response.setHeader('Retry-After', String(Math.ceil(retryAfter)));
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      error,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }

  private extractMessage(exception: unknown, exceptionResponse: string | object | null): string | string[] {
    if (typeof exceptionResponse === 'string') {
      return exceptionResponse;
    }
    if (exceptionResponse && typeof exceptionResponse === 'object' && 'message' in exceptionResponse) {
      return (exceptionResponse as { message: string | string[] }).message;
    }
    if (exception instanceof Error) {
      return exception.message;
    }
    return 'Internal server error';
  }
}
