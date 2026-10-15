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

  async setRefreshTokenHash(id: string, refreshTokenHash: string | null): Promise<void> {
    await this.userModel.updateOne({ _id: id }, { refreshTokenHash }).exec();
  }
}
