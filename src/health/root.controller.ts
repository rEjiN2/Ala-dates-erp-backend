import { Controller, Get } from '@nestjs/common';

/** Answers GET / so opening the bare server URL (locally or on Vercel) shows the API is up instead of a 404. */
@Controller()
export class RootController {
  @Get()
  index(): { message: string; status: string; health: string; timestamp: string } {
    return {
      message: 'Ala Dates ERP API is running',
      status: 'ok',
      health: '/health',
      timestamp: new Date().toISOString(),
    };
  }
}
