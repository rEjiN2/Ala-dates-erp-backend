import type { TestProject } from 'vitest/node';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * Starts ONE in-memory replica set for the whole test run (a replica set
 * because services use transactions). Each spec file gets its own database
 * on it via mongooseTestRoot(), so files can still run in parallel without
 * starting a mongod each.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  project.provide('mongoUri', replSet.getUri());

  return async () => {
    await replSet.stop();
  };
}
