import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const { method, originalUrl } = request;
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.log(method, originalUrl, response.statusCode, start),
        error: () => this.log(method, originalUrl, response.statusCode || 500, start),
      }),
    );
  }

  private log(method: string, path: string, statusCode: number, start: number): void {
    const duration = Date.now() - start;
    this.logger.log(`${method} ${path} ${statusCode} ${duration}ms`);
  }
}
