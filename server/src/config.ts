export interface MarketCfg { commissionPct: number; faucetDaily: number; faucetRepCap: number; faucetInitial: number; listingDays: number; bidDays: number; autoAcceptHours: number; counterMaxRounds: number; transferFeePct: number; maxPointsPerTx: number; maxBalance: number }

export interface Config {
  port: number
  dbPath: string
  dbSynchronous: 'NORMAL' | 'FULL'
  registrationCode: string | null
  allowOpenRegistration: boolean
  webhookAllowPrivate: boolean
  taskRequestTimeoutS: number
  rate: { messagePerMin: number; taskPerMin: number; historyPerMin: number; registerPerHourPerIp: number; webhookTestPerMin: number; profilePerHour: number; topicsPerMin: number; marketPublishPerDay: number; marketBidPerDay: number; marketCounterPerDay: number }
  adminToken: string | null
  market: MarketCfg
  presenceWindowMs: number
  wsIdleTimeoutMs: number
  scanIntervalMs: number
  lastSeenThrottleMs: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8080),
    dbPath: env.DB_PATH ?? 'data/agentlink.db',
    dbSynchronous: env.DB_SYNCHRONOUS === 'FULL' ? 'FULL' : 'NORMAL',
    registrationCode: env.REGISTRATION_CODE || null,
    allowOpenRegistration: env.ALLOW_OPEN_REGISTRATION === 'true',
    webhookAllowPrivate: env.WEBHOOK_ALLOW_PRIVATE === 'true',
    taskRequestTimeoutS: Number(env.TASK_REQUEST_TIMEOUT_S ?? 86400),
    rate: {
      messagePerMin: Number(env.RATE_LIMIT_MESSAGE_PER_MIN ?? 60),
      taskPerMin: Number(env.RATE_LIMIT_TASK_PER_MIN ?? 20),
      historyPerMin: Number(env.RATE_LIMIT_HISTORY_PER_MIN ?? 120),
      registerPerHourPerIp: Number(env.RATE_LIMIT_REGISTER_PER_HOUR ?? 10),
      webhookTestPerMin: Number(env.RATE_LIMIT_WEBHOOK_TEST_PER_MIN ?? 6),
      profilePerHour: Number(env.RATE_LIMIT_PROFILE_PER_HOUR ?? 5),
      topicsPerMin: Number(env.RATE_LIMIT_TOPICS_PER_MIN ?? 60),
      marketPublishPerDay: Number(env.RATE_LIMIT_MARKET_PUBLISH_PER_DAY ?? 5),
      marketBidPerDay: Number(env.RATE_LIMIT_MARKET_BID_PER_DAY ?? 30),
      marketCounterPerDay: Number(env.RATE_LIMIT_MARKET_COUNTER_PER_DAY ?? 20),
    },
    adminToken: env.ADMIN_TOKEN || null,
    market: {
      commissionPct: Number(env.MARKET_COMMISSION_PCT ?? 5),
      faucetDaily: Number(env.FAUCET_DAILY ?? 100),
      faucetRepCap: Number(env.FAUCET_REPUTATION_CAP ?? 200),
      faucetInitial: Number(env.FAUCET_INITIAL ?? 500),
      listingDays: Number(env.MARKET_LISTING_DAYS ?? 7),
      bidDays: Number(env.MARKET_BID_DAYS ?? 3),
      autoAcceptHours: Number(env.MARKET_AUTO_ACCEPT_HOURS ?? 48),
      counterMaxRounds: Number(env.COUNTER_MAX_ROUNDS ?? 5),
      transferFeePct: Number(env.MARKET_TRANSFER_FEE_PCT ?? 5),
      maxPointsPerTx: 1_000_000, maxBalance: 10_000_000,
    },
    presenceWindowMs: 5 * 60_000,
    wsIdleTimeoutMs: 90_000,
    scanIntervalMs: 30_000,
    lastSeenThrottleMs: 60_000,
  }
}
