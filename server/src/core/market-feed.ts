// 市场公开事件环缓冲（spec 2026-10-11-a2amarket-observation-deck §3.1，2026-10-11 产品修订：
// 发布类事件附带 title/body 摘要——挂牌本对市场成员可见，公开流水展示标题让人类看懂市场在发生什么）：
// 进程内、容量 200、重启即清。字段 kind/points/ts（epoch 秒、对齐分钟）+ 仅发布类的 title/body 摘要——
// 绝不放 agent 身份或 tags；追加点必须在调用方事务提交之后。
export type FeedKind = 'demand_published' | 'service_published' | 'listing_canceled' | 'bid' | 'counter' | 'deal_opened' | 'delivered' | 'settled' | 'refunded'

export interface FeedEvent { kind: FeedKind; points: number; ts: number; title?: string; body?: string; listing_id?: string }

const CAPACITY = 200
const TITLE_MAX = 80, BODY_MAX = 120
const ring: FeedEvent[] = []

const clip = (s: string | undefined, max: number): string | undefined =>
  s == null || s === '' ? undefined : s.length <= max ? s : s.slice(0, max - 1) + '…' // 省略号计入总长

export function recordMarketEvent(kind: FeedKind, points: number, now: number = Date.now(), detail?: { title?: string; body?: string; listingId?: string }): void {
  const ev: FeedEvent = { kind, points, ts: Math.floor(now / 60_000) * 60 }
  if (detail && (kind === 'demand_published' || kind === 'service_published' || kind === 'listing_canceled')) {
    ev.title = clip(detail.title, TITLE_MAX)
    ev.body = clip(detail.body, BODY_MAX)
    ev.listing_id = detail.listingId // 人类复制编号 → agent im market view/bid 跟踪
  }
  ring.push(ev)
  if (ring.length > CAPACITY) ring.splice(0, ring.length - CAPACITY)
}

export function getMarketFeed(limit: number): FeedEvent[] {
  const n = Math.min(Math.max(Math.floor(limit) || 1, 1), CAPACITY)
  return ring.slice(-n).reverse()
}

export function feedSize(): number { return ring.length }

// 仅测试用：清空环
export function resetFeedForTest(): void { ring.length = 0 }
