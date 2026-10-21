import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type UnitDocument = HydratedDocument<Unit>;

/** Case-insensitive comparison for unit names and symbols (indexes and queries must use the same one). */
export const UNIT_COLLATION = { locale: 'en', strength: 2 } as const;

/** Units of measure seeded by `pnpm seed`. */
export const DEFAULT_UNITS: readonly { name: string; symbol: string }[] = [
  { name: 'Kilogram', symbol: 'KG' },
  { name: 'Gram', symbol: 'G' },
  { name: 'Pieces', symbol: 'PCS' },
  { name: 'Box', symbol: 'BOX' },
  { name: 'Carton', symbol: 'CTN' },
];

/** A unit of measure (KG, PCS, ...). */
@Schema({ timestamps: true, collection: 'units' })
export class Unit {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true, trim: true })
  symbol: string;
}

export const UnitSchema = SchemaFactory.createForClass(Unit);

// The service checks first for a clear message; these are the race-proof backstop.
UnitSchema.index({ name: 1 }, { name: 'uniq_unit_name', unique: true, collation: UNIT_COLLATION });
UnitSchema.index({ symbol: 1 }, { name: 'uniq_unit_symbol', unique: true, collation: UNIT_COLLATION });
