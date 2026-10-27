import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { insertOnlyPlugin } from '../../../common/utils/insert-only.plugin.js';

export type AuditLogDocument = HydratedDocument<AuditLog>;

export enum AuditAction {
  CREATED = 'created',
  UPDATED = 'updated',
  CANCELLED = 'cancelled',
  SUBMITTED = 'submitted',
  /** A submitted document (cash handover) was approved or rejected. */
  APPROVED = 'approved',
  REJECTED = 'rejected',
  /** A master record (party, cashier, ...) was switched to inactive; the changes list everything else edited with it. */
  DEACTIVATED = 'deactivated',
  /** A document (e.g. a voucher PDF) was generated. */
  PRINTED = 'printed',
  /** A master record with no history (user, role) was removed. */
  DELETED = 'deleted',
  /** An administrator set a new password for a user. */
  PASSWORD_RESET = 'password-reset',
  /** A user changed their own password. */
  PASSWORD_CHANGED = 'password-changed',
  /** Cheque lifecycle (entityType "cheque"). */
  DEPOSITED = 'deposited',
  CLEARED = 'cleared',
  RETURNED = 'returned',
  /** An administrator undid the last cheque step (deposit, clearance or return). */
  UNDONE = 'undone',
}

/** One human-readable difference, e.g. { field: 'cashier', label: 'Cashier', from: 'Ali', to: 'Omar' }. */
@Schema({ _id: false })
export class AuditChange {
  @Prop({ required: true })
  field: string;

  @Prop({ required: true })
  label: string;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  from: unknown;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  to: unknown;
}

export const AuditChangeSchema = SchemaFactory.createForClass(AuditChange);

/**
 * Append-only history of business changes. Entries are written by
 * AuditService.record inside the caller's transaction, so an entry exists if
 * and only if the change it describes was committed.
 */
@Schema({ collection: 'audit_logs', versionKey: false })
export class AuditLog {
  /** Kind of record, e.g. "cash-receipt". */
  @Prop({ required: true, trim: true })
  entityType: string;

  @Prop({ type: Types.ObjectId, required: true })
  entityId: Types.ObjectId;

  /** Human reference at the time of the action, e.g. a voucher number. */
  @Prop({ trim: true })
  entityRef?: string;

  @Prop({ type: String, enum: AuditAction, required: true })
  action: AuditAction;

  @Prop({ type: Types.ObjectId, required: true })
  actorId: Types.ObjectId;

  /** Snapshot of the actor's name when the action happened. */
  @Prop({ required: true, trim: true })
  actorName: string;

  @Prop({ required: true })
  at: Date;

  @Prop({ type: [AuditChangeSchema], default: [] })
  changes: AuditChange[];

  @Prop({ trim: true })
  reason?: string;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);

AuditLogSchema.index({ entityType: 1, entityId: 1, at: -1 });
AuditLogSchema.plugin(insertOnlyPlugin, { modelName: AuditLog.name });
