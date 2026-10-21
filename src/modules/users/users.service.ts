import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession, QueryFilter } from 'mongoose';
import { ACTIVE_USER_FILTER, User, UserDocument, isUserActive } from './schemas/user.schema.js';
import { Role, type RoleDocument } from '../roles/schemas/role.schema.js';
import { DataScope, Permission, hasPermission } from '../roles/permissions.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';

/** What a Collected By / Paid By user is picked for (GET /users/lookup?for=...). */
export enum CollectorPurpose {
  RECEIPT = 'receipt',
  PAYMENT = 'payment',
}

/** The permission a user's role needs to be chosen for each purpose. */
export const COLLECTOR_PERMISSION: Readonly<Record<CollectorPurpose, Permission>> = {
  [CollectorPurpose.RECEIPT]: Permission.CASH_RECEIPTS_CREATE,
  [CollectorPurpose.PAYMENT]: Permission.CASH_PAYMENTS_CREATE,
};

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Role.name) private readonly roleModel: Model<RoleDocument>,
  ) {}

  async findByEmailWithCredentials(email: string): Promise<UserDocument | null> {
    return this.userModel
      .findOne({ email: email.toLowerCase() })
      .select('+passwordHash +refreshTokenHash')
      .populate('role')
      .exec();
  }

  async findByIdWithRole(id: string): Promise<UserDocument | null> {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }
    return this.userModel.findById(id).populate('role').exec();
  }

  async findByIdWithRefreshHash(id: string): Promise<UserDocument | null> {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }
    return this.userModel.findById(id).select('+refreshTokenHash').populate('role').exec();
  }

  /** Names by id, for display; unknown ids are absent. */
  async findNames(ids: readonly string[]): Promise<Map<string, string>> {
    const objectIds = ids.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    if (objectIds.length === 0) {
      return new Map();
    }
    const users = await this.userModel.find({ _id: { $in: objectIds } }).select('name').lean().exec();
    return new Map(users.map((user) => [user._id.toString(), user.name]));
  }

  async exists(id: string): Promise<boolean> {
    return Types.ObjectId.isValid(id) && Boolean(await this.userModel.exists({ _id: id }).exec());
  }

  /**
   * Every user, inactive ones included, for filters such as "Created by":
   * a deactivated user can still be the creator of existing records.
   */
  async lookup(): Promise<{ id: string; name: string }[]> {
    const users = await this.userModel.find().select('name').sort({ name: 1 }).lean().exec();
    return users.map((user) => ({ id: user._id.toString(), name: user.name }));
  }

  /**
   * Users who may be put on a voucher for `purpose`: active, and their role
   * holds its :create permission. Without vouchers:select-collector the viewer gets only themselves.
   */
  async collectorLookup(
    purpose: CollectorPurpose,
    viewer: { id: string; permissions?: readonly string[] },
  ): Promise<{ id: string; name: string }[]> {
    const roleIds = await this.roleModel.find({ permissions: COLLECTOR_PERMISSION[purpose] }).distinct('_id').exec();
    const filter: QueryFilter<UserDocument> = { ...ACTIVE_USER_FILTER, role: { $in: roleIds } };
    if (!hasPermission(viewer, Permission.VOUCHERS_SELECT_COLLECTOR)) filter._id = new Types.ObjectId(viewer.id);
    const users = await this.userModel.find(filter).select('name').sort({ name: 1 }).lean().exec();
    return users.map((user) => ({ id: user._id.toString(), name: user.name }));
  }

  /** A user who may be put on a new voucher: active, and their role holds `permission` (400 otherwise). */
  async findEligibleCollector(id: string, permission: Permission, session?: ClientSession): Promise<UserDocument> {
    const user = Types.ObjectId.isValid(id)
      ? await this.userModel
          .findById(id)
          .populate({ path: 'role', options: { session } })
          .session(session ?? null)
          .exec()
      : null;
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    if (!isUserActive(user)) {
      throw new BadRequestException(`User ${user.name} is inactive`);
    }
    if (!(user.role as RoleDocument | null)?.permissions?.includes(permission)) {
      throw new BadRequestException(`User ${user.name} cannot be chosen here: their role lacks ${permission}`);
    }
    return user;
  }

  /** The request user for a user loaded with its role populated. */
  toAuthenticatedUser(user: UserDocument): AuthenticatedUser {
    const role = user.role as RoleDocument;
    return {
      id: user.id as string,
      email: user.email,
      name: user.name,
      role: { id: role.id as string, name: role.name },
      permissions: role.permissions,
      dataScope: role.dataScope ?? DataScope.ALL,
      allowedCashAccountIds: (user.allowedCashAccountIds ?? []).map((id) => id.toString()),
      mustChangePassword: Boolean(user.mustChangePassword),
    };
  }

  async setRefreshTokenHash(id: string, refreshTokenHash: string | null): Promise<void> {
    await this.userModel.updateOne({ _id: id }, { refreshTokenHash }).exec();
  }
}
