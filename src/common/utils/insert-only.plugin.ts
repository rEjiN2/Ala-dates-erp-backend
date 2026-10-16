import type { Schema } from 'mongoose';

export class InsertOnlyViolationError extends Error {
  constructor(modelName: string, operation: string) {
    super(`${modelName} records are insert-only: "${operation}" is not allowed`);
    this.name = 'InsertOnlyViolationError';
  }
}

const BLOCKED_QUERY_OPS: Array<
  | 'updateOne'
  | 'updateMany'
  | 'replaceOne'
  | 'findOneAndUpdate'
  | 'findOneAndReplace'
  | 'findOneAndDelete'
  | 'deleteOne'
  | 'deleteMany'
> = [
  'updateOne',
  'updateMany',
  'replaceOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'deleteOne',
  'deleteMany',
];

/**
 * Makes a collection append-only at the Mongoose layer: every update, replace
 * and delete path throws, and so does re-saving a loaded document. Services
 * for these collections expose no edit/delete methods either; this catches a
 * future caller that reaches for the model directly.
 */
export function insertOnlyPlugin(schema: Schema, options: { modelName: string }): void {
  const refuse = (operation: string) => {
    throw new InsertOnlyViolationError(options.modelName, operation);
  };

  for (const operation of BLOCKED_QUERY_OPS) {
    schema.pre(operation, { document: false, query: true }, () => refuse(operation));
  }
  schema.pre(['updateOne', 'deleteOne'], { document: true, query: false }, function () {
    refuse('document update/delete');
  });
  schema.pre('save', function () {
    if (!this.isNew) {
      refuse('save of an existing document');
    }
  });
  schema.pre('bulkWrite', function (ops: Array<Record<string, unknown>>) {
    const blocked = ops.find((op) => !('insertOne' in op));
    if (blocked) {
      refuse(`bulkWrite ${Object.keys(blocked)[0]}`);
    }
  });
}
