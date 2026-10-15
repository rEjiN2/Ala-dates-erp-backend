import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Counter, CounterSchema } from './schemas/counter.schema.js';
import { SequenceService } from './sequence.service.js';

@Module({
  imports: [MongooseModule.forFeature([{ name: Counter.name, schema: CounterSchema }])],
  providers: [SequenceService],
  exports: [SequenceService],
})
export class SequenceModule {}
