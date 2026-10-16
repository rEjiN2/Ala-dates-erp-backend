import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User, UserDocument } from './schemas/user.schema.js';

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private readonly userModel: Model<UserDocument>) {}

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

  async setRefreshTokenHash(id: string, refreshTokenHash: string | null): Promise<void> {
    await this.userModel.updateOne({ _id: id }, { refreshTokenHash }).exec();
  }
}
