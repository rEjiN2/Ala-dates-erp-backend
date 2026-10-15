import { inject } from 'vitest';
import { MongooseModule } from '@nestjs/mongoose';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

/** Connects to the shared test replica set, in a database private to the calling spec file. */
export function mongooseTestRoot(dbName: string) {
  return MongooseModule.forRoot(inject('mongoUri'), { dbName });
}
