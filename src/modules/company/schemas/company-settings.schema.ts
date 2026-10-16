import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { UserSnapshot, UserSnapshotSchema } from '../../../common/schemas/user-snapshot.schema.js';

export type CompanySettingsDocument = HydratedDocument<CompanySettings>;

export const COMPANY_SETTINGS_ENTITY_TYPE = 'company-settings';
/** Value of `singleton` on the one and only settings document. */
export const COMPANY_SETTINGS_KEY = 'company';

/** Starting values, written once when the profile is first read or seeded. All editable. */
export const COMPANY_SETTINGS_DEFAULTS = {
  legalName: 'ALA DATES LLC',
  addressLine1: 'Jurf 3',
  city: 'Ajman',
  country: 'United Arab Emirates',
  currencyCode: 'AED',
} as const;

/** The company's own details, printed on vouchers. Exactly one document. */
@Schema({ collection: 'company_settings' })
export class CompanySettings {
  /** Always COMPANY_SETTINGS_KEY; the unique index is what keeps this a single document. */
  @Prop({ required: true, unique: true, immutable: true, default: COMPANY_SETTINGS_KEY })
  singleton: string;

  @Prop({ required: true, trim: true })
  legalName: string;

  @Prop({ type: String, trim: true, default: null })
  tradeName: string | null;

  @Prop({ type: String, trim: true, default: null })
  addressLine1: string | null;

  @Prop({ type: String, trim: true, default: null })
  addressLine2: string | null;

  @Prop({ type: String, trim: true, default: null })
  city: string | null;

  @Prop({ type: String, trim: true, default: null })
  country: string | null;

  @Prop({ type: String, trim: true, default: null })
  phone: string | null;

  @Prop({ type: String, trim: true, lowercase: true, default: null })
  email: string | null;

  @Prop({ type: String, trim: true, default: null })
  website: string | null;

  /** UAE Tax Registration Number: 15 digits. */
  @Prop({ type: String, trim: true, default: null })
  trn: string | null;

  /** Id of a FileAttachment (see FilesModule), never a storage key or URL. */
  @Prop({ type: Types.ObjectId, ref: 'FileAttachment', default: null })
  logoFileRef: Types.ObjectId | null;

  @Prop({ required: true, trim: true, uppercase: true, default: COMPANY_SETTINGS_DEFAULTS.currencyCode })
  currencyCode: string;

  @Prop({ type: String, trim: true, default: null })
  receiptFooterText: string | null;

  @Prop({ type: UserSnapshotSchema, default: null })
  updatedBy: UserSnapshot | null;

  @Prop({ type: Date, default: null })
  updatedAt: Date | null;
}

export const CompanySettingsSchema = SchemaFactory.createForClass(CompanySettings);
