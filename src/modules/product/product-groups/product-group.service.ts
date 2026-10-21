import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ProductGroup, ProductGroupDocument } from './schemas/product-group.schema.js';
import { CreateProductGroupDto } from './dto/create-product-group.dto.js';
import { UpdateProductGroupDto } from './dto/update-product-group.dto.js';
import { wouldCreateCycle } from '../../../common/utils/cycle.util.js';
import { buildTree, type TreeNode } from '../../../common/utils/tree.util.js';
import { SequenceService } from '../../sequence/sequence.service.js';
import { PRODUCT_GROUP_CODE_SEQUENCE } from './product-group-code.js';
import { Product, ProductDocument } from '../products/schemas/product.schema.js';

export interface ProductGroupTreeItem {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
}

export type ProductGroupTreeNode = TreeNode<ProductGroupTreeItem>;

@Injectable()
export class ProductGroupService {
  constructor(
    @InjectModel(ProductGroup.name) private readonly productGroupModel: Model<ProductGroupDocument>,
    private readonly sequenceService: SequenceService,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
  ) {}

  async findAll(): Promise<ProductGroupDocument[]> {
    return this.productGroupModel.find().sort({ name: 1 }).exec();
  }

  async findById(id: string): Promise<ProductGroupDocument> {
    return this.getByIdOrThrow(id);
  }

  async create(dto: CreateProductGroupDto): Promise<ProductGroupDocument> {
    const underId = dto.under ?? null;
    if (underId) {
      await this.getByIdOrThrow(underId, 'Parent product group');
    }

    // Issued only after validation passes, so a rejected request burns no number.
    const code = await this.sequenceService.nextCode(PRODUCT_GROUP_CODE_SEQUENCE);

    try {
      return await this.productGroupModel.create({
        code,
        name: dto.name,
        under: underId ? new Types.ObjectId(underId) : null,
      });
    } catch (error) {
      throw this.toFriendlyError(error);
    }
  }

  async update(id: string, dto: UpdateProductGroupDto): Promise<ProductGroupDocument> {
    const existing = await this.getByIdOrThrow(id);

    const underProvided = Object.prototype.hasOwnProperty.call(dto, 'under');
    const nextUnderId = underProvided ? dto.under ?? null : this.underIdOf(existing);

    if (underProvided && nextUnderId) {
      const isCycle = await wouldCreateCycle(id, nextUnderId, (candidateId) =>
        this.getUnderIdOf(candidateId),
      );
      if (isCycle) {
        throw new BadRequestException('This change would create a circular parent reference');
      }
      await this.getByIdOrThrow(nextUnderId, 'Parent product group');
    }

    if (dto.name !== undefined) existing.name = dto.name;
    existing.under = nextUnderId ? new Types.ObjectId(nextUnderId) : null;

    try {
      return await existing.save();
    } catch (error) {
      throw this.toFriendlyError(error);
    }
  }

  async remove(id: string): Promise<{ success: true }> {
    await this.getByIdOrThrow(id);

    const childCount = await this.productGroupModel.countDocuments({ under: new Types.ObjectId(id) }).exec();
    if (childCount > 0) {
      throw new ConflictException('Cannot delete a product group that still has child groups');
    }
    if (await this.productModel.exists({ productGroupId: new Types.ObjectId(id) }).exec()) {
      throw new ConflictException('Cannot delete a product group that still has products');
    }

    await this.productGroupModel.deleteOne({ _id: id }).exec();
    return { success: true };
  }

  async getTree(rootId?: string): Promise<ProductGroupTreeNode[]> {
    const allGroups = await this.productGroupModel.find().sort({ name: 1 }).lean().exec();

    const items: ProductGroupTreeItem[] = allGroups.map((group) => ({
      id: group._id.toString(),
      code: group.code,
      name: group.name,
      parentId: group.under ? group.under.toString() : null,
    }));

    if (rootId && !items.some((item) => item.id === rootId)) {
      throw new NotFoundException(`Product group ${rootId} not found`);
    }

    return buildTree(items, rootId);
  }

  private async getByIdOrThrow(id: string, label = 'Product group'): Promise<ProductGroupDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`${label} id "${id}" is not a valid id`);
    }
    const group = await this.productGroupModel.findById(id).exec();
    if (!group) {
      throw new NotFoundException(`${label} ${id} not found`);
    }
    return group;
  }

  private async getUnderIdOf(id: string): Promise<string | null> {
    const group = await this.productGroupModel.findById(id).select('under').lean().exec();
    return group?.under ? group.under.toString() : null;
  }

  private underIdOf(group: ProductGroupDocument): string | null {
    return group.under ? group.under.toString() : null;
  }

  private toFriendlyError(error: unknown): Error {
    if (this.isDuplicateKeyError(error)) {
      return new ConflictException(
        'Generated product group code is already in use; the code counter is behind existing data and needs re-syncing (pnpm migrate:code-sequences)',
      );
    }
    return error instanceof Error ? error : new Error('Unknown error');
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
  }
}
