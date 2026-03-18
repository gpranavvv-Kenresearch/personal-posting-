/**
 * schedule.ts — Batch Schedule Config
 * Maps batch numbers to posting times (mirrors n8n IF nodes exactly)
 *
 * Each entry: { batch, hour, minute }
 * Timezone: Asia/Kolkata (IST) — matches n8n flow
 */

export interface BatchSlot {
  batch: number;
  hour: number;
  minute: number;
}

// Batches are numbered sequentially in chronological order
// batch 1 = first slot of the day, batch 2 = second slot, etc.
export const BATCH_SCHEDULE: BatchSlot[] = [
  { batch: 1,  hour: 11, minute: 0  },
  { batch: 2,  hour: 11, minute: 30 },
  { batch: 3,  hour: 12, minute: 0  },
  { batch: 4,  hour: 12, minute: 30 },
  { batch: 5,  hour: 13, minute: 0  },
  { batch: 6,  hour: 13, minute: 30 },
  { batch: 7,  hour: 14, minute: 0  },
  { batch: 8,  hour: 15, minute: 0  },
  { batch: 9,  hour: 15, minute: 30 },
  { batch: 10, hour: 16, minute: 0  },
  { batch: 11, hour: 17, minute: 5  },
  { batch: 12, hour: 17, minute: 30 },
];

/**
 * Returns the batch number for the current IST time, or null if no match.
 * Matches within a 4-minute window so a 5-min tick never misses a slot.
 * Pass firedToday to avoid firing the same batch twice.
 */
export function getCurrentBatch(firedToday: Set<number> = new Set()): number | null {
  const now = new Date();

  // Convert to IST (UTC+5:30)
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffset + now.getTimezoneOffset() * 60 * 1000);

  const currentTotalMinutes = ist.getHours() * 60 + ist.getMinutes();

  for (const slot of BATCH_SCHEDULE) {
    if (firedToday.has(slot.batch)) continue;

    const slotTotalMinutes = slot.hour * 60 + slot.minute;
    const diff = currentTotalMinutes - slotTotalMinutes;

    // Fire if current time is 0–4 minutes past the slot
    if (diff >= 0 && diff < 5) {
      return slot.batch;
    }
  }
  return null;
}

// Facebook batch schedule — independent fixed times
export const FB_SCHEDULE: BatchSlot[] = [
  { batch: 1, hour: 11, minute: 20 },
  { batch: 2, hour: 12, minute: 20 },
  { batch: 3, hour: 13, minute: 20 },
  { batch: 4, hour: 15, minute: 20 },
  { batch: 5, hour: 16, minute: 20 },
];

// LinkedIn batch schedule — independent fixed times
export const LI_SCHEDULE: BatchSlot[] = [
  { batch: 1, hour: 11, minute: 40 },
  { batch: 2, hour: 13, minute: 40 },
  { batch: 3, hour: 16, minute: 40 },
];

/**
 * Returns all batch slots for display/debugging
 */
export function printSchedule() {
  const fmt = (h: number, m: number) =>
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

  console.log('\n📅 X Schedule (IST):');
  for (const s of BATCH_SCHEDULE) {
    console.log(`  Batch ${String(s.batch).padStart(2, ' ')} → ${fmt(s.hour, s.minute)} IST`);
  }
  console.log();
}