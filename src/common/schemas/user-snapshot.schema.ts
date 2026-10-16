import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { AuthenticatedUser } from '../../modules/auth/interfaces/auth.types.js';

/**
 * Who performed an action. Always built from the authenticated request user,
 * never from a request body.
 */
export type Actor = Pick<AuthenticatedUser, 'id' | 'name'>;

/**
 * A user as they were at the time of an action. The name is copied rather than
 * populated so a later rename doesn't rewrite history.
 */
@Schema({ _id: false })
export class UserSnapshot {
  @Prop({ type: Types.ObjectId, required: true })
  id: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name: string;
}

export const UserSnapshotSchema = SchemaFactory.createForClass(UserSnapshot);

export function toUserSnapshot(actor: Actor): UserSnapshot {
  return { id: new Types.ObjectId(actor.id), name: actor.name };
}

/** API shape of a snapshot: plain string id, or null when no one was recorded (legacy records). */
export function userRefOf(snapshot: UserSnapshot | null | undefined): { id: string; name: string } | null {
  return snapshot ? { id: snapshot.id.toString(), name: snapshot.name } : null;
}
