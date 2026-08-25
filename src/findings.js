'use strict';

// Statuses that still call for developer action; everything else (covered, mitigated,
// irrelevant, risk-accepted, …) is informational and stays in the summary comment only.
const OPEN_REQUIREMENT_STATUSES = new Set(['SentToAgent', 'SentToDevelopers', 'SuggestedByClover']);
const OPEN_THREAT_STATUSES = new Set(['SentToDevelopers', 'SuggestedByAppSec', 'SuggestedByClover']);

const PRIORITY_ORDER = ['Critical', 'High', 'Medium', 'Low'];
const MAX_INLINE_FINDINGS = 15;
const MIN_LOCATION_CONFIDENCE = 3;

function priorityRank(priority) {
  const rank = PRIORITY_ORDER.indexOf(priority);
  return rank === -1 ? PRIORITY_ORDER.length : rank;
}

// Picks the findings worth an inline comment: open requirements and threats, most severe first,
// requirements before threats on ties, capped so a PR is never flooded.
function selectActionItems({ requirements, threats }, limit = MAX_INLINE_FINDINGS) {
  const candidates = [
    ...requirements
      .filter((requirement) => OPEN_REQUIREMENT_STATUSES.has(requirement.status))
      .map((requirement) => ({ finding: requirement, kind: 'Requirement', priority: requirement.priority })),
    ...threats
      .filter((threat) => OPEN_THREAT_STATUSES.has(threat.status))
      .map((threat) => ({ finding: threat, kind: 'Threat', priority: threat.severity })),
  ];

  return candidates
    .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority))
    .slice(0, limit);
}

// Joins the backend's locations back to the selected findings, dropping weak placements.
function matchLocations(actionItems, locations) {
  const idToActionItem = new Map(actionItems.map((item) => [String(item.finding.id), item]));

  return locations
    .filter((location) => location.confidence >= MIN_LOCATION_CONFIDENCE)
    .map((location) => {
      const actionItem = idToActionItem.get(String(location.findingId));
      return actionItem ? { ...actionItem, location } : null;
    })
    .filter(Boolean);
}

module.exports = { MAX_INLINE_FINDINGS, MIN_LOCATION_CONFIDENCE, matchLocations, priorityRank, selectActionItems };
