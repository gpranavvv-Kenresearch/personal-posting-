const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function istParts(date = new Date()) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    date: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function atOrAfter(parts, hour, minute) {
  return parts.hour > hour || (parts.hour === hour && parts.minute >= minute);
}

function before(parts, hour, minute) {
  return parts.hour < hour || (parts.hour === hour && parts.minute < minute);
}

export function sumDailyCounters(counters, today) {
  if (!counters || counters.date !== today) return { total: 0, validForToday: false };
  const total = Object.entries(counters)
    .filter(([key, value]) => key !== 'date' && typeof value === 'number' && Number.isFinite(value))
    .reduce((sum, [, value]) => sum + value, 0);
  return { total, validForToday: true };
}

export function detectMajorRules(snapshot, now = new Date()) {
  const parts = istParts(now);
  const events = [];
  const heartbeatAt = snapshot.heartbeat?.ts || snapshot.heartbeat?.at || snapshot.heartbeat?.timestamp || snapshot.heartbeat?.updatedAt;
  const heartbeatDate = heartbeatAt ? istParts(new Date(heartbeatAt)).date : null;
  const heartbeatAgeMs = heartbeatAt ? now.getTime() - new Date(heartbeatAt).getTime() : Infinity;
  const heartbeatFresh = heartbeatDate === parts.date && heartbeatAgeMs >= 0 && heartbeatAgeMs <= 120_000;

  if (atOrAfter(parts, 10, 20) && before(parts, 10, 30) && !heartbeatFresh) {
    events.push({
      type: 'flow_not_started', severity: 'major', title: 'Posting flow is not confirmed alive by 10:20 IST',
      summary: 'No heartbeat dated today was found. The scheduled posting workflow may not be running.',
      fingerprint: `flow-not-started:${parts.date}`,
      evidence: { expectedBy: `${parts.date}T10:20:00+05:30`, heartbeatAt: heartbeatAt || null, maximumHeartbeatAgeSeconds: 120 },
    });
  }


  if (atOrAfter(parts, 10, 30) && before(parts, 18, 31) && !heartbeatFresh) {
    events.push({
      type: 'daemon_heartbeat_stale', severity: 'major', title: 'Posting daemon heartbeat is stale during the posting window',
      summary: 'The scheduler heartbeat is missing or older than two minutes. Scheduled batches may no longer be executing.',
      fingerprint: `daemon-heartbeat-stale:${parts.date}`,
      evidence: { heartbeatAt: heartbeatAt || null, maximumHeartbeatAgeSeconds: 120 },
    });
  }

  if (atOrAfter(parts, 18, 30)) {
    const count = sumDailyCounters(snapshot.counters, parts.date);
    if (!count.validForToday || count.total < 500) {
      events.push({
        type: 'daily_total_below_500', severity: 'major', title: 'Daily successful post total is below 500 at 18:30 IST',
        summary: `The authoritative daily counter reports ${count.total} successful posts; the required overall minimum is 500.`,
        fingerprint: `daily-total-below-500:${parts.date}`,
        evidence: { date: parts.date, successfulPosts: count.total, requiredMinimum: 500, counterDateValid: count.validForToday },
      });
    }
  }
  return events;
}
