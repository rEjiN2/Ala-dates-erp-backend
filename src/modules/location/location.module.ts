import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Location, LocationSchema } from './schemas/location.schema.js';
import { LocationService } from './location.service.js';
import { LocationController } from './location.controller.js';
import { SequenceModule } from '../sequence/sequence.module.js';

@Module({
  imports: [MongooseModule.forFeature([{ name: Location.name, schema: LocationSchema }]), SequenceModule],
  controllers: [LocationController],
  providers: [LocationService],
  exports: [LocationService],
})
export class LocationModule {}
