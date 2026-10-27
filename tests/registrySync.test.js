/**
 * Registry sync must follow a chain when its subnet id changes.
 *
 * Upsert-by-subnetId inserts a second row and leaves the old subnet in place,
 * so the API keeps serving the previous evm chain id. FRQTAL moved from
 * subnet 5vcCHz5f… / evm 62789 to subnet 2E2AhbGH… / evm 62786 while the
 * registry folder stayed `frqtal`.
 */

const registryService = require('../src/services/registryService');

function memoryChains(initial) {
  const docs = initial.map((doc, index) => ({
    _id: doc._id || `id-${index + 1}`,
    validators: [],
    ...doc
  }));

  const readPath = (obj, keyPath) => keyPath.split('.').reduce(
    (acc, key) => (acc == null ? acc : acc[key]),
    obj
  );

  const matches = (doc, query) => Object.entries(query).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && Array.isArray(expected.$in)) {
      return expected.$in.map(String).includes(String(readPath(doc, key)));
    }
    return readPath(doc, key) === expected;
  });

  return {
    docs: () => docs,
    find: async (query) => docs.filter(doc => matches(doc, query)).map(doc => ({ ...doc })),
    findOne: async (query) => {
      const found = docs.find(doc => matches(doc, query));
      return found ? { ...found } : null;
    },
    deleteMany: async (query) => {
      const before = docs.length;
      for (let i = docs.length - 1; i >= 0; i -= 1) {
        if (matches(docs[i], query)) docs.splice(i, 1);
      }
      return { deletedCount: before - docs.length };
    },
    findOneAndUpdate: async (filter, update, options = {}) => {
      let index = docs.findIndex(doc => matches(doc, filter));
      if (index === -1) {
        if (!options.upsert) return null;
        docs.push({ _id: `id-${docs.length + 1}`, ...(update.$setOnInsert || {}) });
        index = docs.length - 1;
      }
      Object.assign(docs[index], update.$set || {});
      return { ...docs[index] };
    }
  };
}

function registryChain({ folderName, name, subnetId, blockchainId, evmChainId }) {
  return registryService.parseRegistryChain({
    subnetId,
    name,
    network: 'mainnet',
    chains: [{ blockchainId, name, evmChainId }]
  }, folderName)[0];
}

describe('registryService.syncToDatabase subnet moves', () => {
  const oldSubnet = '5vcCHz5fgd1hWyXaKiLnMAVjmh4qW7yFxNbASBjxCXZYE445N';
  const newSubnet = '2E2AhbGH8jSsT3Riur2Pjjg2twpQj7xeD6u9SgmkmGkcWKTBzf';

  it('replaces the old subnet row when the registry folder moves', async () => {
    const chains = memoryChains([{
      _id: 'frqtal-row',
      subnetId: oldSubnet,
      blockchainId: '2JepXG35p5i2old',
      chainId: '2JepXG35p5i2old',
      chainName: 'FRQTAL',
      evmChainId: 62789,
      validators: [{ nodeId: 'NodeID-kept' }],
      registryMetadata: { folderName: 'frqtal', source: 'l1-registry' }
    }]);
    registryService.chains = [
      registryChain({
        folderName: 'frqtal',
        name: 'FRQTAL',
        subnetId: newSubnet,
        blockchainId: '2FJM6WqyDGX2new',
        evmChainId: 62786
      })
    ];

    await registryService.syncToDatabase(chains);

    expect(chains.docs()).toHaveLength(1);
    expect(chains.docs()[0]).toMatchObject({
      _id: 'frqtal-row',
      subnetId: newSubnet,
      blockchainId: '2FJM6WqyDGX2new',
      evmChainId: 62786,
      chainName: 'FRQTAL',
      validators: [{ nodeId: 'NodeID-kept' }]
    });
  });

  it('keeps one row when a previous sync already inserted the new subnet', async () => {
    const chains = memoryChains([
      {
        _id: 'old-row',
        subnetId: oldSubnet,
        blockchainId: '2JepXG35p5i2old',
        chainName: 'FRQTAL',
        evmChainId: 62789,
        validators: [{ nodeId: 'NodeID-kept' }],
        registryMetadata: { folderName: 'frqtal', source: 'l1-registry' }
      },
      {
        _id: 'duplicate-row',
        subnetId: newSubnet,
        blockchainId: '2FJM6WqyDGX2new',
        chainName: 'FRQTAL',
        evmChainId: 62786,
        validators: [],
        registryMetadata: { folderName: 'frqtal', source: 'l1-registry' }
      }
    ]);
    registryService.chains = [
      registryChain({
        folderName: 'frqtal',
        name: 'FRQTAL',
        subnetId: newSubnet,
        blockchainId: '2FJM6WqyDGX2new',
        evmChainId: 62786
      })
    ];

    await registryService.syncToDatabase(chains);

    const remaining = chains.docs();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]._id).toBe('old-row');
    expect(remaining[0].subnetId).toBe(newSubnet);
    expect(remaining[0].evmChainId).toBe(62786);
    expect(remaining[0].validators).toEqual([{ nodeId: 'NodeID-kept' }]);
  });

  it('inserts a new folder without touching an unrelated chain', async () => {
    const chains = memoryChains([{
      _id: 'frqtal-row',
      subnetId: newSubnet,
      blockchainId: '2FJM6WqyDGX2new',
      chainName: 'FRQTAL',
      evmChainId: 62786,
      registryMetadata: { folderName: 'frqtal', source: 'l1-registry' }
    }]);
    registryService.chains = [
      registryChain({
        folderName: 'frqtal',
        name: 'FRQTAL',
        subnetId: newSubnet,
        blockchainId: '2FJM6WqyDGX2new',
        evmChainId: 62786
      }),
      registryChain({
        folderName: 'tomatochain',
        name: 'Tomatochain',
        subnetId: 'LdAcdLzdbEAuPjivWf9HzhBZiztq31xbhGE21xTUqA1YP7LGH',
        blockchainId: '2PXzkiiy7zhXtomato',
        evmChainId: 77294
      })
    ];

    await registryService.syncToDatabase(chains);

    const remaining = chains.docs();
    expect(remaining).toHaveLength(2);
    expect(remaining.find(doc => doc._id === 'frqtal-row').subnetId).toBe(newSubnet);
    expect(remaining.find(doc => doc.evmChainId === 77294)).toMatchObject({
      chainName: 'Tomatochain',
      subnetId: 'LdAcdLzdbEAuPjivWf9HzhBZiztq31xbhGE21xTUqA1YP7LGH'
    });
  });
});
