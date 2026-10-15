import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { Counter, CounterDocument } from './schemas/counter.schema.js';
import { CodeSequence, formatSequenceCode } from './code-sequence.js';

@Injectable()
export class SequenceService {
  constructor(@InjectModel(Counter.name) private readonly counterModel: Model<CounterDocument>) {}

  /**
   * Issues the next number for `key` with one atomic $inc, so concurrent
   * callers can never receive the same value. Pass the caller's session to
   * issue it inside a transaction: an aborted transaction then also rolls
   * back the increment, leaving no gap.
   */
  async next(key: string, session?: ClientSession): Promise<number> {
    const counter = await this.counterModel
      .findOneAndUpdate({ key }, { $inc: { seq: 1 } }, { returnDocument: 'after', upsert: true, session })
      .exec();

    return counter.seq;
  }

  async nextCode(sequence: CodeSequence, session?: ClientSession): Promise<string> {
    return formatSequenceCode(sequence, await this.next(sequence.key, session));
  }

  /**
   * Raises the counter to at least `value` (never lowers it), so the next
   * issued number is above it. Idempotent and safe to run while the app is
   * issuing numbers.
   */
  async ensureAtLeast(key: string, value: number, session?: ClientSession): Promise<number> {
    const counter = await this.counterModel
      .findOneAndUpdate({ key }, { $max: { seq: value } }, { returnDocument: 'after', upsert: true, session })
      .exec();

    return counter.seq;
  }
}
