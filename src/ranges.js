// Time-range definitions. `window` is how far back to look (seconds),
// `bucket` is the aggregation granularity (seconds). Bucket sizes are chosen
// so each range renders a comfortable number of cells (~60-170).
export const RANGES = {
  '10min': { label: '近 10 分钟', window: 10 * 60, bucket: 10 },
  '1h': { label: '近 1 小时', window: 60 * 60, bucket: 60 },
  '1d': { label: '近 1 天', window: 24 * 60 * 60, bucket: 10 * 60 },
  '7d': { label: '近 7 天', window: 7 * 24 * 60 * 60, bucket: 60 * 60 },
  '1m': { label: '近 1 月', window: 30 * 24 * 60 * 60, bucket: 6 * 60 * 60 },
};

export const DEFAULT_RANGE = '1d';

// Longest window drives retention/pruning.
export const MAX_WINDOW = Math.max(...Object.values(RANGES).map((r) => r.window));
