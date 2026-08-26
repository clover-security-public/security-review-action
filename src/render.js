'use strict';

const { priorityRank } = require('./findings');
const { RE_ANALYZE_BUTTON_MARKER } = require('./context');
const { STICKY_COMMENT_MARKER, findingCommentMarker } = require('./github');

const MAX_LISTED_REQUIREMENTS = 30;
const MAX_LISTED_THREATS = 20;

// ThreatCategory serializes through a custom converter — tolerate both a plain
// string and an object shape.
function asDisplayString(value) {
  if (value == null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  return value.name ?? value.category ?? String(value);
}

function renderRequirements(requirements) {
  if (requirements.length === 0) {
    return '';
  }

  const sorted = [...requirements].sort(
    (left, right) => priorityRank(left.priority) - priorityRank(right.priority),
  );
  const listed = sorted.slice(0, MAX_LISTED_REQUIREMENTS);

  const items = listed.map((requirement) => {
    const framework = [requirement.frameworkName, requirement.requirementIdNumber]
      .filter(Boolean)
      .join(' ');
    const heading = `- ${requirement.priority ? `**[${requirement.priority}]**` : ''} ${requirement.tailoredRequirement}${framework ? ` _(${framework})_` : ''}`;

    if (!requirement.tailoredDescription) {
      return heading;
    }

    return `${heading}\n  <details><summary>Details</summary>\n\n  ${requirement.tailoredDescription}\n  </details>`;
  });

  const truncationNote =
    sorted.length > listed.length
      ? `\n\n_…and ${sorted.length - listed.length} more requirements. See the full list in Clover._`
      : '';

  return `\n### Security requirements (${requirements.length})\n\n${items.join('\n')}${truncationNote}\n`;
}

function renderThreats(threats) {
  if (threats.length === 0) {
    return '';
  }

  const sorted = [...threats].sort(
    (left, right) => priorityRank(left.severity) - priorityRank(right.severity),
  );
  const listed = sorted.slice(0, MAX_LISTED_THREATS);

  const rows = listed.map((threat) => {
    const cells = [
      threat.severity ?? '',
      threat.threat ?? '',
      asDisplayString(threat.category),
    ].map((cell) => String(cell).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));

    return `| ${cells.join(' | ')} |`;
  });

  const truncationNote =
    sorted.length > listed.length
      ? `\n\n_…and ${sorted.length - listed.length} more threats._`
      : '';

  return `\n### Threats (${threats.length})\n\n| Severity | Threat | Category |\n|---|---|---|\n${rows.join('\n')}${truncationNote}\n`;
}

// Comments are posted by the workflow's token (usually github-actions[bot]), so the body itself
// carries the Clover identity.
const INLINE_COMMENT_HEADER = '**🛡️ [Clover Security Review](https://github.com/clover-security-public/security-review-action)**';

function findingFooter({ finding, kind }) {
  const parts =
    kind === 'Requirement'
      ? ['Security requirement', finding.priority, [finding.frameworkName, finding.requirementIdNumber].filter(Boolean).join(' ')]
      : ['Threat', finding.severity, asDisplayString(finding.category)];

  return `_${parts.filter(Boolean).join(' · ')}_`;
}

// Prefers the line-specific comment written by Clover for this location; falls back to the finding text.
function renderFindingComment({ finding, kind, location }) {
  const lines = [findingCommentMarker(finding.id), INLINE_COMMENT_HEADER, ''];

  if (location?.comment) {
    lines.push(location.comment.trim());
  } else if (kind === 'Requirement') {
    lines.push(`**${finding.tailoredRequirement}**`);

    if (finding.tailoredDescription) {
      lines.push('', finding.tailoredDescription);
    }
  } else {
    lines.push(`**${finding.threat}**`);

    if (finding.summary) {
      lines.push('', finding.summary);
    }
  }

  if (!location?.comment && finding.countermeasures) {
    lines.push('', `<details><summary>Countermeasures</summary>\n\n${finding.countermeasures}\n</details>`);
  }

  lines.push('', findingFooter({ finding, kind }));

  return lines.join('\n');
}

const RUN_OUTCOME_TEXT = {
  'created': 'new review created and analyzed',
  'manual-skipped': 'design changes are not re-analyzed automatically in manual mode — tick the box below to re-analyze',
  'reanalyzed': 're-analysis completed',
  'reanalyzed-on-request': 're-analysis completed on request',
  'timeout': 'still analyzing — results will appear on the next run',
  'up-to-date': 'review already up to date, nothing to re-analyze',
};

// Every run leaves a visible trace, even when nothing changed.
function renderRunFooter(run) {
  if (!run) {
    return [];
  }

  const when = run.timestamp ? new Date(run.timestamp).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '';
  const commit = run.headSha ? ` · commit \`${run.headSha.slice(0, 7)}\`` : '';
  const outcome = RUN_OUTCOME_TEXT[run.outcome] ?? run.outcome ?? '';
  const lines = [`_Last run: ${when}${commit}${outcome ? ` — ${outcome}` : ''}._`];

  if (run.recalculation === 'manual') {
    lines.push('', `- [ ] 🔁 **Re-analyze this pull request** ${RE_ANALYZE_BUTTON_MARKER}`);
  }

  return lines;
}

function renderReviewComment({ inlineFindingCount = 0, requirements, run, summary, threats }) {
  const summaryText = summary.summary ?? summary.shortSummary;

  const sections = [
    STICKY_COMMENT_MARKER,
    '## 🛡️ Clover Security Review',
    '',
  ];

  if (summaryText) {
    sections.push(summaryText, '');
  }

  const requirementsSection = renderRequirements(requirements);
  const threatsSection = renderThreats(threats);

  if (!summaryText && !requirementsSection && !threatsSection) {
    sections.push(
      '_The review completed without findings — the pull request may not contain analyzable design content._',
      '',
    );
  } else {
    sections.push(requirementsSection, threatsSection);
  }

  if (inlineFindingCount > 0) {
    sections.push(
      `_${inlineFindingCount} action item${inlineFindingCount === 1 ? '' : 's'} ${inlineFindingCount === 1 ? 'is' : 'are'} also posted as inline comments on the changed lines they apply to._`,
      '',
    );
  }

  sections.push('---', ...renderRunFooter(run), '', '_Generated by the [Clover Security Review](https://github.com/clover-security-public/security-review-action) action._');

  return sections.filter((section) => section !== null).join('\n').replace(/\n{3,}/g, '\n\n');
}

function renderTimeoutComment(run) {
  return [
    STICKY_COMMENT_MARKER,
    '## 🛡️ Clover Security Review',
    '',
    '_The security review is taking longer than expected. Results will appear on the next run of this workflow._',
    '',
    '---',
    ...renderRunFooter({ ...run, outcome: 'timeout' }),
  ].join('\n');
}

module.exports = { renderFindingComment, renderReviewComment, renderTimeoutComment };
