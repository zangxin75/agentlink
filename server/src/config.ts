import { dirname, join } from 'node:path'
import nodemailer from 'nodemailer' // 唯一新运行时依赖（spec §1）；静态导入（r1-M1：ESM 下运行时 require 直接崩）
import type { MailTransport } from './core/regcodes.js'

export interface MarketCfg { commissionPct: number; faucetDaily: number; faucetRepCap: number; faucetInitial: number; listingDays: number; bidDays: number; autoAcceptHours: number; counterMaxRounds: number; transferFeePct: number; maxPointsPerTx: number; maxBalance: number }

export interface Config {
  port: number
  dbPath: string
  dbSynchronous: 'NORMAL' | 'FULL'
  registrationCode: string | null
  allowOpenRegistration: boolean
  regCodes: Map<string, string> // code → owner（分码注册即归属）
  humanIds: string[] // AGENTLINK_HUMAN_IDS：这些 agent id 是 human 角色
  defaultOwner: string | null // 无分码时注册归属（AGENTLINK_DEFAULT_OWNER，缺省 humanIds[0]）
  webhookAllowPrivate: boolean
  taskRequestTimeoutS: number
  rate: { messagePerMin: number; taskPerMin: number; historyPerMin: number; registerPerHourPerIp: number; webhookTestPerMin: number; profilePerHour: number; topicsPerMin: number; marketPublishPerDay: number; marketBidPerDay: number; marketCounterPerDay: number; feedPerMinPerIp: number; feedPerMinGlobal: number; regcodeApplyIpPerHour: number; regcodeApplyEmailPerHour: number; regcodeVerifyIpPerHour: number }
  smtpTransport: () => MailTransport | null // SMTP_* 全配 → nodemailer transporter；缺任一 → null（apply 503）
  adminToken: string | null
  market: MarketCfg
  presenceWindowMs: number
  wsIdleTimeoutMs: number
  scanIntervalMs: number
  lastSeenThrottleMs: number
  trustedProxies: string
  filesDir: string
  fileMaxMb: number
  fileQuotaMb: number
  fileTtlDays: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8080),
    dbPath: env.DB_PATH ?? 'data/agentlink.db',
    dbSynchronous: env.DB_SYNCHRONOUS === 'FULL' ? 'FULL' : 'NORMAL',
    registrationCode: env.REGISTRATION_CODE || null,
    allowOpenRegistration: env.ALLOW_OPEN_REGISTRATION === 'true',
    // 分码注册即归属（spec §1.5）：'owner:code,owner2:code2'——owner 可含冒号，用 lastIndexOf 切
    regCodes: (() => {
      const m = new Map<string, string>()
      for (const pair of (env.AGENTLINK_REG_CODES || '').split(',').map(s => s.trim()).filter(Boolean)) {
        const i = pair.lastIndexOf(':'); if (i > 0) m.set(pair.slice(i + 1), pair.slice(0, i))
      }
      return m
    })(),
    humanIds: (env.AGENTLINK_HUMAN_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
    defaultOwner: env.AGENTLINK_DEFAULT_OWNER || (env.AGENTLINK_HUMAN_IDS || '').split(',')[0]?.trim() || null,
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
      feedPerMinPerIp: Number(env.RATE_LIMIT_FEED_PER_MIN ?? 60),
      feedPerMinGlobal: Number(env.RATE_LIMIT_FEED_GLOBAL_PER_MIN ?? 600),
      regcodeApplyIpPerHour: Number(env.RATE_LIMIT_REGCODE_APPLY_IP ?? 3),
      regcodeApplyEmailPerHour: Number(env.RATE_LIMIT_REGCODE_APPLY_EMAIL ?? 2),
      regcodeVerifyIpPerHour: Number(env.RATE_LIMIT_REGCODE_VERIFY_IP ?? 10),
    },
    // SMTP 工厂（spec §5）：任一 SMTP_* 缺失 → null（apply 503）；465 隐式 TLS
    smtpTransport: () => {
      const host = env.SMTP_HOST, user = env.SMTP_USER, pass = env.SMTP_PASSWORD
      if (!host || !user || !pass) return null
      const from = env.SMTP_FROM || user
      const t = nodemailer.createTransport({ host, port: Number(env.SMTP_PORT ?? 465), secure: Number(env.SMTP_PORT ?? 465) === 465, auth: { user, pass } })
      return { sendMail: (o) => t.sendMail({ from, to: o.to, subject: o.subject, text: o.text }) }
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
    // 可信代理白名单（逗号分隔 IP/CIDR）：仅这些来源的 XFF 被采信为限流键（审计 2026-10-21 core MEDIUM/ops F3）
    trustedProxies: env.TRUSTED_PROXIES ?? '127.0.0.0/8,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
    // 文件通道（设计 v3）：blob 目录缺省随 dbPath 同级 files/；跨卷部署由部署侧保证 DB 卷余量
    filesDir: env.FILES_DIR ?? join(dirname(env.DB_PATH ?? 'data/agentlink.db'), 'files'),
    fileMaxMb: Number(env.FILE_MAX_MB ?? 32),
    fileQuotaMb: Number(env.FILE_QUOTA_MB ?? 200),
    fileTtlDays: Number(env.FILE_TTL_DAYS ?? 14),
  }
}
