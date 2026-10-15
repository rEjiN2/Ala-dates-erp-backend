import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import { createAppValidationPipe } from './common/pipes/app-validation.pipe.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor.js';
import type { EnvConfig } from './config/env.validation.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService<EnvConfig, true>);

  app.use(cookieParser());

  app.useGlobalPipes(createAppValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  const corsOrigin = configService.get('CORS_ORIGIN', { infer: true });
  app.enableCors({
    origin: corsOrigin ? corsOrigin.split(',') : true,
    credentials: true,
  });

  const port = configService.get('PORT', { infer: true });
  await app.listen(port);
}

await bootstrap();
