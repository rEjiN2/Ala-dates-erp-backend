import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import { ROLE_ENTITY_TYPE, ROLE_NAME_COLLATION, Role, RoleDocument } from './schemas/role.schema.js';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto.js';
import { ALL_PERMISSIONS, DataScope } from './permissions.js';
import { User, UserDocument } from '../users/schemas/user.schema.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/schemas/audit-log.schema.js';
import { diffFields, type DiffField } from '../audit/field-diff.js';
import type { Actor } from '../../common/schemas/user-snapshot.schema.js';
import { runInTransaction } from '../../common/utils/transaction.util.js';

export interface RoleView {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  dataScope: DataScope;
  isSystem: boolean;
  /** Users holding this role, inactive ones included. */
  userCount: number;
}

interface RoleDisplay extends Record<string, unknown> {
  name: string;
  description: string | null;
  permissions: string;
  dataScope: string;
}

const AUDITED_FIELDS: readonly DiffField<RoleDisplay>[] = [
  { key: 'name', label: 'Name' },
  { key: 'description', label: 'Description' },
  { key: 'permissions', label: 'Permissions' },
  { key: 'dataScope', label: 'Data scope' },
];

/**
 * Roles (roles:manage). A system role (the seeded admin) can't be edited or
 * deleted; a role still held by a user can't be deleted. Changes apply to
 * its users on their next request.
 */
@Injectable()
export class RolesService {
  constructor(
    @InjectModel(Role.name) private readonly roleModel: Model<RoleDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly auditService: AuditService,
  ) {}

  async findById(id: string): Promise<RoleDocument | null> {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }
    return this.roleModel.findById(id).exec();
  }

  async findByName(name: string): Promise<RoleDocument | null> {
    return this.roleModel.findOne({ name }).exec();
  }

  /** Every permission a role can hold, for the role editor. */
  permissions(): readonly string[] {
    return ALL_PERMISSIONS;
  }

  async list(): Promise<RoleView[]> {
    const [roles, counts] = await Promise.all([
      this.roleModel.find().sort({ name: 1 }).exec(),
      this.userModel
        .aggregate<{ _id: Types.ObjectId; count: number }>([{ $group: { _id: '$role', count: { $sum: 1 } } }])
        .exec(),
    ]);
    const countByRole = new Map(counts.map((row) => [row._id.toString(), row.count]));
    return roles.map((role) => this.toView(role, countByRole.get(role.id as string) ?? 0));
  }

  /** For the user form's role dropdown. */
  async lookup(): Promise<{ id: string; name: string; dataScope: DataScope }[]> {
    const roles = await this.roleModel.find().select('name dataScope').sort({ name: 1 }).lean().exec();
    return roles.map((role) => ({
      id: role._id.toString(),
      name: role.name,
      dataScope: role.dataScope ?? DataScope.ALL,
    }));
  }

  async findOne(id: string): Promise<RoleView> {
    const role = await this.getById(id);
    return this.toView(role, await this.userModel.countDocuments({ role: role._id }).exec());
  }

  async create(dto: CreateRoleDto, actor: Actor): Promise<RoleView> {
    const created = await this.inTransaction(async (session) => {
      await this.assertNameFree(dto.name, null, session);
      const [role] = await this.roleModel.create(
        [
          {
            name: dto.name,
            description: dto.description ?? undefined,
            permissions: [...dto.permissions],
            dataScope: dto.dataScope,
            isSystem: false,
          },
        ],
        { session },
      );
      await this.auditService.record(
        { entityType: ROLE_ENTITY_TYPE, entityId: role._id, entityRef: role.name, action: AuditAction.CREATED, actor },
        session,
      );
      return role;
    });
    return this.toView(created, 0);
  }

  /** Rejects with "No changes to save" when nothing would change. */
  async update(id: string, dto: UpdateRoleDto, actor: Actor): Promise<RoleView> {
    const provided = (key: keyof UpdateRoleDto) => Object.prototype.hasOwnProperty.call(dto, key);
    if (provided('name') && !dto.name) {
      throw new BadRequestException('name cannot be empty');
    }
    await this.inTransaction(async (session) => {
      const role = await this.getById(id, session);
      this.assertNotSystem(role, 'edited');
      const before = this.display(role);
      if (provided('name')) role.name = dto.name!;
      if (provided('description')) role.description = dto.description ?? undefined;
      if (provided('permissions')) role.permissions = [...(dto.permissions ?? [])];
      if (provided('dataScope')) role.dataScope = dto.dataScope!;

      const changes = diffFields(before, this.display(role), AUDITED_FIELDS);
      if (changes.length === 0) {
        throw new BadRequestException('No changes to save');
      }
      if (changes.some((change) => change.field === 'name')) {
        await this.assertNameFree(role.name, role._id, session);
      }
      await role.save({ session });
      await this.auditService.record(
        {
          entityType: ROLE_ENTITY_TYPE,
          entityId: role._id,
          entityRef: role.name,
          action: AuditAction.UPDATED,
          actor,
          changes,
        },
        session,
      );
    });
    return this.findOne(id);
  }

  async remove(id: string, actor: Actor): Promise<{ success: true }> {
    return this.inTransaction(async (session) => {
      const role = await this.getById(id, session);
      this.assertNotSystem(role, 'deleted');
      const users = await this.userModel.countDocuments({ role: role._id }).session(session).exec();
      if (users > 0) {
        throw new ConflictException(
          `Cannot delete role "${role.name}": ${users} user(s) have it. Move them to another role first.`,
        );
      }
      await this.roleModel.deleteOne({ _id: role._id }, { session }).exec();
      await this.auditService.record(
        { entityType: ROLE_ENTITY_TYPE, entityId: role._id, entityRef: role.name, action: AuditAction.DELETED, actor },
        session,
      );
      return { success: true as const };
    });
  }

  private async getById(id: string, session?: ClientSession): Promise<RoleDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`Role id "${id}" is not a valid id`);
    }
    const role = await this.roleModel
      .findById(id)
      .session(session ?? null)
      .exec();
    if (!role) {
      throw new NotFoundException(`Role ${id} not found`);
    }
    return role;
  }

  private assertNotSystem(role: RoleDocument, action: string): void {
    if (role.isSystem) {
      throw new BadRequestException(`The "${role.name}" role is managed by the system and cannot be ${action}`);
    }
  }

  private async assertNameFree(name: string, exceptId: Types.ObjectId | null, session: ClientSession): Promise<void> {
    const clash = await this.roleModel
      .findOne({ name: name.trim(), ...(exceptId ? { _id: { $ne: exceptId } } : {}) })
      .collation(ROLE_NAME_COLLATION)
      .session(session)
      .exec();
    if (clash) {
      throw new ConflictException(`A role named "${clash.name}" already exists`);
    }
  }

  private display(role: RoleDocument): RoleDisplay {
    return {
      name: role.name,
      description: role.description ?? null,
      permissions: [...role.permissions].sort().join(', '),
      dataScope: role.dataScope ?? DataScope.ALL,
    };
  }

  private toView(role: RoleDocument, userCount: number): RoleView {
    return {
      id: role.id as string,
      name: role.name,
      description: role.description ?? null,
      permissions: [...role.permissions],
      dataScope: role.dataScope ?? DataScope.ALL,
      isSystem: Boolean(role.isSystem),
      userCount,
    };
  }

  private async inTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    try {
      return await runInTransaction(this.connection, work);
    } catch (error) {
      // Backstop for a race the pre-check can't see: the unique name index rejects the second writer.
      if ((error as { code?: number })?.code === 11000) {
        throw new ConflictException('A role with this name already exists');
      }
      throw error;
    }
  }
}
