import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Role, RoleDocument } from './schemas/role.schema.js';

@Injectable()
export class RolesService {
  constructor(@InjectModel(Role.name) private readonly roleModel: Model<RoleDocument>) {}

  async findById(id: string): Promise<RoleDocument | null> {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }
    return this.roleModel.findById(id).exec();
  }

  async findByName(name: string): Promise<RoleDocument | null> {
    return this.roleModel.findOne({ name }).exec();
  }
}
