'use strict';

// Mirrors the server's ItemPriority names, least to most severe. Unknown-priority findings count as
// pending but never toward blocking. The server may camel-case the map keys, so compare lowercased.
const PRIORITY_ORDER = ['insignificant', 'low', 'medium', 'high', 'critical'];

function priorityRank(priority) {
  return PRIORITY_ORDER.indexOf(String(priority ?? '').toLowerCase());
}

function countBlockingFindings(priorityToPendingFindingCountMap, blockingPriority) {
  const minRank = priorityRank(blockingPriority);

  return Object.entries(priorityToPendingFindingCountMap ?? {})
    .filter(([priority]) => priorityRank(priority) >= minRank)
    .reduce((sum, [, count]) => sum + count, 0);
}

function countPendingFindings(priorityToPendingFindingCountMap) {
  return Object.values(priorityToPendingFindingCountMap ?? {}).reduce((sum, count) => sum + count, 0);
}

// Parses the "blocking-rules" input: one rule per line, comma-separated clauses, e.g.
//   importance >= high, findings >= medium, max 0
//   findings >= critical, max 0
// "importance >= X" gates the rule on the review's importance (omitted = applies to every review);
// "findings >= Y" sets the lowest finding priority counted (omitted = every priority);
// "max N" (required) is the highest allowed count. Throws on any clause it does not understand.
function parseBlockingRules(input) {
  return String(input ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const rule = { maxPendingFindings: null, minFindingPriority: PRIORITY_ORDER[0], minImportance: null };

      for (const clause of line.split(',').map((part) => part.trim())) {
        const importanceMatch = /^importance\s*>=\s*([a-z]+)$/i.exec(clause);
        const findingsMatch = /^findings\s*>=\s*([a-z]+)$/i.exec(clause);
        const maxMatch = /^max\s*=?\s*(\d+)$/i.exec(clause);

        if (importanceMatch && priorityRank(importanceMatch[1]) >= 0) {
          rule.minImportance = importanceMatch[1].toLowerCase();
        } else if (findingsMatch && priorityRank(findingsMatch[1]) >= 0) {
          rule.minFindingPriority = findingsMatch[1].toLowerCase();
        } else if (maxMatch) {
          rule.maxPendingFindings = Number.parseInt(maxMatch[1], 10);
        } else {
          throw new Error(`Invalid blocking rule clause "${clause}" in rule "${line}": expected "importance >= <priority>", "findings >= <priority>" or "max <count>" with a priority of ${PRIORITY_ORDER.join(', ')}.`);
        }
      }

      if (rule.maxPendingFindings === null) {
        throw new Error(`Blocking rule "${line}" is missing its "max <count>" clause.`);
      }

      return rule;
    });
}

// Returns one violation per exceeded rule. A rule gated on importance is skipped when the review's
// importance is below the gate (or unknown).
function evaluateBlockingRules(priorityToPendingFindingCountMap, reviewImportance, rules) {
  return rules
    .filter((rule) => rule.minImportance === null || priorityRank(reviewImportance) >= priorityRank(rule.minImportance))
    .map((rule) => ({ blockingFindings: countBlockingFindings(priorityToPendingFindingCountMap, rule.minFindingPriority), rule }))
    .filter(({ blockingFindings, rule }) => blockingFindings > rule.maxPendingFindings);
}

// Splits a "paths" style input on newlines and commas: "docs/**\n*.md, *.png" → three patterns.
function parsePatterns(input) {
  return String(input ?? '')
    .split(/[\n,]/)
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
}

module.exports = { PRIORITY_ORDER, countBlockingFindings, countPendingFindings, evaluateBlockingRules, parseBlockingRules, parsePatterns, priorityRank };
