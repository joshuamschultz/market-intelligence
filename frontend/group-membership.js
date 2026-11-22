import { count, dateLabel, helpTooltip, number, numeric, percent, safe, segment, signed } from './ui.js';

export const membershipWindows = ['4w', '12w'];
const choices = [['dated', 'Dated membership'], ['current', 'Current members']];
const metrics = new Map(membershipWindows.flatMap((window) => [[`velocity${window}`, window], [`rankChange${window}`, window]]));
const reasonLabels = {
  projection_not_prepared: 'The current membership comparison has not been prepared for this session and revision.',
  projection_invalid: 'The stored current membership comparison could not be verified.',
  roster_mismatch: 'The prepared comparison does not match the current group roster.',
  anchor_snapshot_unprepared: 'The current group snapshot is not prepared for this session and revision.',
  rank_date_unprepared: 'The prepared rank archive is missing for a required session.',
  rank_witness_unprepared: 'The rank archive could not be verified for a required session.',
  insufficient_member_coverage: 'Too few current-ranked members also have ranks on the comparison date.',
  insufficient_peers: 'Too few peer groups meet the comparison coverage rules.',
};

export const membershipWindow = (metric) => metrics.get(metric);

export function groupMembershipView(data, { level, selection, classification } = {}) {
  const projection = data.groupMembershipProjection;
  const latestNasdaq = level !== 'theme' && (data.classificationSystem || classification) === 'nasdaq' &&
    projection?.basis === 'current-membership' && projection.anchorDate === data.date;
  if (!latestNasdaq) return { basis: 'dated', projection: null };
  const groups = (data.groups ?? []).filter((group) => group.level === level && numeric(group.rank));
  const hasVelocity = (basis) => groups.some((group) => membershipWindows.some((window) => numeric(groupMembershipValue(group, `velocity${window}`, basis))));
  const automatic = ['ready', 'partial'].includes(projection.state) && !hasVelocity('dated') && hasVelocity('current');
  const unavailableReasons = Object.fromEntries(membershipWindows.map((window) => {
    const reasons = new Set(groups.map((group) => group.currentMembership?.horizons?.[window]?.reason));
    return [window, reasons.size === 1 ? reasons.values().next().value : null];
  }));
  return { basis: selection === 'current' || (selection !== 'dated' && automatic) ? 'current' : 'dated', projection, unavailableReasons };
}

export function groupMembershipValue(group, metric, basis, comparisonMetric) {
  if (basis !== 'current') return group[metric];
  const window = membershipWindow(metric);
  if (window) return group.currentMembership?.horizons?.[window]?.state === 'ready' ? group.currentMembership[metric] : null;
  const comparison = membershipWindow(comparisonMetric);
  if (metric === 'percentile' && comparison) {
    const horizon = group.currentMembership?.horizons?.[comparison];
    return horizon?.state === 'ready' ? horizon.current?.percentile : null;
  }
  return group[metric];
}

function reasonLabel(reason) {
  return Object.hasOwn(reasonLabels, reason) ? reasonLabels[reason] : '';
}

export function groupMembershipUnavailable(view, window) {
  if (view.basis !== 'current') return 'Dated group ranks are unavailable for the required sessions.';
  const projection = view.projection;
  return reasonLabel(view.unavailableReasons?.[window] || projection?.reason) ||
    (projection?.state === 'unprepared' ? reasonLabels.projection_not_prepared : 'No groups meet the matched-member and peer coverage rules for this comparison.');
}

function matchCount(group, horizon) {
  const roster = group.currentMembership?.cohortCount;
  return numeric(horizon?.matchedMembers) && numeric(roster) ? `${count(horizon.matchedMembers)} of ${count(roster)} current-ranked members matched` : '';
}

export function groupMembershipTileNote(group, window) {
  const horizon = group.currentMembership?.horizons?.[window];
  if (!horizon) return '';
  const ranked = group.currentMembership.cohortCount;
  const members = numeric(horizon.matchedMembers) && numeric(ranked) ? `${count(horizon.matchedMembers)}/${count(ranked)} matched` : '';
  return [members, numeric(horizon.peerCount) && `${count(horizon.peerCount)} peers`].filter(Boolean).join(' · ');
}

export function groupMembershipDetail(group, window, view) {
  if (view.basis !== 'current' || !window) return '';
  const horizon = group.currentMembership?.horizons?.[window];
  const { cohortCount, tradedRosterCount, representativeness } = group.currentMembership ?? {};
  const priorDate = horizon?.priorDate ?? view.projection?.comparisonDates?.[window];
  const anchorDate = view.projection?.anchorDate;
  const matched = matchCount(group, horizon);
  const peers = numeric(horizon?.peerCount) ? `${count(horizon.peerCount)} peer groups` : '';
  const traded = numeric(cohortCount) && numeric(tradedRosterCount)
    ? `${count(cohortCount)} of ${count(tradedRosterCount)} traded members ranked at anchor${numeric(representativeness) ? ` (${percent(representativeness * 100, 0)})` : ''}` : '';
  const prior = numeric(horizon?.priorFiniteMembers) ? `${count(horizon.priorFiniteMembers)} of the ranked cohort had ranks at comparison` : '';
  const values = horizon?.state === 'ready' && horizon.prior && horizon.current ?
    `Median constituent RS ${number(horizon.prior.medianRS)} → ${number(horizon.current.medianRS)} · Peer rank ${count(horizon.prior.rank)} → ${count(horizon.current.rank)} · Peer percentile ${number(horizon.prior.percentile)} → ${number(horizon.current.percentile)}` : '';
  const reason = horizon?.state === 'ready' ? '' : reasonLabel(horizon?.reason) || groupMembershipUnavailable(view, window);
  return [priorDate && anchorDate && `${dateLabel(priorDate)} to ${dateLabel(anchorDate)}`, matched, peers, traded, prior,
    horizon?.thinSample && 'One-member comparison (n=1)', values, reason].filter(Boolean).join(' · ');
}

export function loadGroupMembershipStyles(doc) {
  if (doc.head.querySelector('[data-group-membership-styles]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./group-membership.css', import.meta.url).href;
  link.setAttribute('data-group-membership-styles', '');
  doc.head.append(link);
}

export function renderGroupMembership(view, { action, helpId }) {
  const { basis, projection } = view;
  const policy = projection?.policy;
  const current = basis === 'current';
  const capture = projection?.classificationCaptureDate;
  const cutoff = projection?.observedReferenceDate;
  const dates = [[capture ? 'Roster capture' : 'Reference cutoff', capture || cutoff], ['Rank session', projection?.anchorDate],
    ...membershipWindows.map((window) => [`${window.toUpperCase()} comparison`, projection?.comparisonDates?.[window]])];
  const help = current ? `The roster is frozen to members with an RS percentile at the rank session. Each horizon uses the same matched members and peers at both dates. Session rank and median RS come from the session snapshot. The matched-peer rank can differ by horizon. This comparison has survivorship and selection bias.${numeric(policy?.minimumPairedCoverage) ? ` At least ${percent(policy.minimumPairedCoverage * 100, 0)} of the current-ranked members must have a rank at the comparison date.` : ''}${numeric(policy?.minimumPeers) ? ` Minimum ${count(policy.minimumPeers)} peer groups.` : ''}${capture && cutoff && cutoff !== capture ? ` Reference cutoff ${dateLabel(cutoff)}.` : ''}`
    : 'Group rank changes use membership applicable to each comparison session.';
  return `<div class="group-membership-bar">
    <div class="group-membership-controls"><span class="group-membership-label">Membership basis</span>
      ${projection ? `<div role="group" aria-label="Membership basis">${segment(action, choices, basis)}</div>` : '<span class="group-membership-label">Dated membership</span>'}
      ${helpTooltip(helpId, 'membership basis', help)}</div>
    ${current ? `<dl class="group-membership-dates">${dates.filter(([, date]) => date).map(([label, date]) =>
      `<div><dt>${label}</dt><dd><time datetime="${safe(date)}">${dateLabel(date)}</time></dd></div>`).join('')}</dl>` : ''}
    ${projection?.state === 'unprepared' ? `<p class="muted">${safe(reasonLabel(projection.reason) || reasonLabels.projection_not_prepared)}</p>` : ''}
  </div>`;
}

export function renderGroupMembershipDetail(group, view) {
  if (view.basis !== 'current') return '';
  return `<section class="group-membership-details" aria-label="Current member comparisons">
    <h3>Current member comparisons</h3>
    <dl>${membershipWindows.map((window) => {
      const velocity = groupMembershipValue(group, `velocity${window}`, view.basis);
      return `<div><dt>${window.toUpperCase()} RS velocity <strong>${numeric(velocity) ? `${signed(velocity)} pts` : 'Unavailable'}</strong></dt>
        <dd>${safe(groupMembershipDetail(group, window, view))}</dd></div>`;
    }).join('')}</dl></section>`;
}

export function groupMembershipExport(group, view, data, snapshotContext) {
  const { basis, projection } = view;
  const comparison = projection && group.currentMembership;
  const scope = projection?.scope;
  const row = {
    sessionDate: data.date, dataVersion: projection?.dataVersion ?? data.dataVersion ?? snapshotContext.dataVersion,
    calculationVersion: projection?.calculationVersion ?? data.calculationVersion, projectionVersion: projection?.projectionVersion,
    universe: scope?.universe ?? snapshotContext.universe, universeVersion: scope?.universeVersion ?? snapshotContext.universeVersion,
    model: scope?.model ?? snapshotContext.model, modelVersion: scope?.modelVersion ?? snapshotContext.modelVersion,
    priceBasis: scope?.priceBasis ?? snapshotContext.basis, benchmark: scope?.benchmark ?? snapshotContext.benchmark,
    classification: scope?.classification ?? data.classificationSystem ?? snapshotContext.classification,
    reference: scope?.reference ?? data.referenceMode ?? snapshotContext.reference,
    membershipBasis: basis === 'current' ? 'current-membership' : 'dated-membership',
    projectionState: projection?.state, projectionReason: projection?.reason,
    projectionAnchorDate: projection?.anchorDate, classificationCaptureDate: projection?.classificationCaptureDate,
    observedReferenceDate: projection?.observedReferenceDate, currentMembershipCohortCount: comparison?.cohortCount,
    currentMembershipTradedRosterCount: comparison?.tradedRosterCount, currentMembershipRepresentativeness: comparison?.representativeness,
    projectionRosterHash: projection?.rosterHash, eligibleCohortHash: projection?.eligibleCohortHash,
    coverageDenominator: projection?.policy?.coverageDenominator, minimumPairedCoverage: projection?.policy?.minimumPairedCoverage,
    minimumMembers: projection?.policy?.minimumMembers, minimumPeers: projection?.policy?.minimumPeers,
    anchorRankSource: projection?.rankSources?.[projection.anchorDate] && JSON.stringify(projection.rankSources[projection.anchorDate]),
  };
  for (const window of membershipWindows) {
    const horizon = comparison?.horizons?.[window];
    const velocity = `velocity${window}`;
    const rankChange = `rankChange${window}`;
    Object.assign(row, {
      [`selectedVelocity${window}`]: groupMembershipValue(group, velocity, basis),
      [`selectedRankChange${window}`]: groupMembershipValue(group, rankChange, basis),
      [`currentMembershipVelocity${window}`]: comparison && groupMembershipValue(group, velocity, 'current'),
      [`currentMembershipRankChange${window}`]: comparison && groupMembershipValue(group, rankChange, 'current'),
      [`comparisonDate${window}`]: horizon?.priorDate ?? projection?.comparisonDates?.[window],
      [`comparisonState${window}`]: horizon?.state, [`comparisonReason${window}`]: horizon?.reason,
      [`comparisonRankSource${window}`]: projection?.rankSources?.[horizon?.priorDate] && JSON.stringify(projection.rankSources[horizon.priorDate]),
      [`matchedMembers${window}`]: horizon?.matchedMembers, [`pairedCoverage${window}`]: horizon?.pairedCoverage,
      [`currentFiniteMembers${window}`]: horizon?.currentFiniteMembers, [`priorFiniteMembers${window}`]: horizon?.priorFiniteMembers,
      [`peerCount${window}`]: horizon?.peerCount, [`thinSample${window}`]: horizon?.thinSample,
      [`currentMatchedMedianRS${window}`]: horizon?.current?.medianRS, [`priorMatchedMedianRS${window}`]: horizon?.prior?.medianRS,
      [`currentMatchedRank${window}`]: horizon?.current?.rank, [`priorMatchedRank${window}`]: horizon?.prior?.rank,
      [`currentMatchedPercentile${window}`]: horizon?.current?.percentile, [`priorMatchedPercentile${window}`]: horizon?.prior?.percentile,
    });
  }
  return row;
}
