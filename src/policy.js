'use strict';

// Mirrors the server's ItemPriority names, least to most severe. Unknown-priority findings count as
// pending but never toward blocking. The server may camel-case the map keys, so compare lowercased.
const PRIORITY_ORDER = ['insignificant', 'low', 'medium', 'high', 'critical'];

function countBlockingFindings(priorityToPendingFindingCountMap, blockingPriority) {
  const minRank = PRIORITY_ORDER.indexOf(blockingPriority);

  return Object.entries(priorityToPendingFindingCountMap ?? {})
    .filter(([priority]) => PRIORITY_ORDER.indexOf(priority.toLowerCase()) >= minRank)
    .reduce((sum, [, count]) => sum + count, 0);
}

function countPendingFindings(priorityToPendingFindingCountMap) {
  return Object.values(priorityToPendingFindingCountMap ?? {}).reduce((sum, count) => sum + count, 0);
}

module.exports = { PRIORITY_ORDER, countBlockingFindings, countPendingFindings };
