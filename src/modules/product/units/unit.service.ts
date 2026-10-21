import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { UNIT_COLLATION, Unit, UnitDocument } from './schemas/unit.schema.js';
import { CreateUnitDto, UpdateUnitDto } from './dto/unit.dto.js';
import { Product, ProductDocument } from '../products/schemas/product.schema.js';

export interface UnitLookupItem {
  id: string;
  name: string;
  symbol: string;
}

@Injectable()
export class UnitService {
  constructor(
    @InjectModel(Unit.name) private readonly unitModel: Model<UnitDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
  ) {}

  async findAll(): Promise<UnitDocument[]> {
    return this.unitModel.find().sort({ name: 1 }).exec();
  }

  async lookup(): Promise<UnitLookupItem[]> {
    const units = await this.unitModel.find().select('name symbol').sort({ name: 1 }).lean().exec();
    return units.map((unit) => ({ id: unit._id.toString(), name: unit.name, symbol: unit.symbol }));
  }

  async findById(id: string): Promise<UnitDocument> {
    return this.getByIdOrThrow(id);
  }

  async create(dto: CreateUnitDto): Promise<UnitDocument> {
    await this.assertNoDuplicates(dto.name, dto.symbol, null);
    try {
      return await this.unitModel.create({ name: dto.name, symbol: dto.symbol });
    } catch (error) {
      throw this.toFriendlyError(error);
    }
  }

  async update(id: string, dto: UpdateUnitDto): Promise<UnitDocument> {
    const unit = await this.getByIdOrThrow(id);
    if (dto.name !== undefined) unit.name = dto.name;
    if (dto.symbol !== undefined) unit.symbol = dto.symbol;
    await this.assertNoDuplicates(unit.name, unit.symbol, unit._id);
    try {
      return await unit.save();
    } catch (error) {
      throw this.toFriendlyError(error);
    }
  }

  /** Only a unit no product uses. */
  async remove(id: string): Promise<{ success: true }> {
    const unit = await this.getByIdOrThrow(id);
    if (await this.productModel.exists({ unitId: unit._id }).exec()) {
      throw new ConflictException(`Cannot delete unit ${unit.symbol}: it is used by products`);
    }
    await this.unitModel.deleteOne({ _id: unit._id }).exec();
    return { success: true };
  }

  private async getByIdOrThrow(id: string): Promise<UnitDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`Unit id "${id}" is not a valid id`);
    }
    const unit = await this.unitModel.findById(id).exec();
    if (!unit) {
      throw new NotFoundException(`Unit ${id} not found`);
    }
    return unit;
  }

  private async assertNoDuplicates(name: string, symbol: string, exceptId: Types.ObjectId | null): Promise<void> {
    const others = exceptId ? { _id: { $ne: exceptId } } : {};
    const sameName = await this.unitModel.findOne({ ...others, name }).collation(UNIT_COLLATION).exec();
    if (sameName) {
      throw new ConflictException(`A unit named "${sameName.name}" already exists`);
    }
    const sameSymbol = await this.unitModel.findOne({ ...others, symbol }).collation(UNIT_COLLATION).exec();
    if (sameSymbol) {
      throw new ConflictException(`Unit symbol "${sameSymbol.symbol}" is already used by ${sameSymbol.name}`);
    }
  }

  private toFriendlyError(error: unknown): unknown {
    const duplicate = error as { code?: number; keyPattern?: Record<string, unknown> };
    if (duplicate?.code !== 11000) return error;
    if (duplicate.keyPattern?.symbol) return new ConflictException('A unit with this symbol already exists');
    return new ConflictException('A unit with this name already exists');
  }
}
