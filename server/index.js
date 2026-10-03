import express from 'express'
import db, { ts, now, DEFAULT_WEIGHTS, DEFAULT_KEYWORD_CAP } from './db.js'
import {
  router as crisisRouter, bindCrisisCore, auditPassive, getCrisisState
} from './crisis.js'
import { router as scheduleRouter, getScheduleState } from './schedule.js'

const app = express()
app.use(express.json())
const PORT = 4160

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const parseSkills = s => { try { return JSON.parse(s || '[]') } catch { return [] } }
const parseJSON = (s, d) => { try { return JSON.parse(s || '') ?? d } catch { return d } }
const parseDims = (s, d) => parseJSON(s, parseJSON(d, []))

// Node:sqlite 同步执行；所有“多步业务动作”放进一个事务，保证策略发布/重算/流程推进不会交叉出半条链路
function tx(fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

const STAGES = ['submitted', 'screening', 'interview', 'offer', 'hired']
const STAGE_LABEL = { submitted: '投递', screening: '筛选', interview: '面试', offer: 'Offer', hired: '录用', rejected: '淘汰' }
const NEXT_STAGE = { submitted: 'screening', screening: 'interview', interview: 'offer', offer: 'hired' }
const PREV_STAGE = { screening: 'submitted', interview: 'screening', offer: 'interview', hired: 'offer' }
const EVENT_LABEL = {
  advance: '阶段推进', reject: '淘汰', offer_accepted: 'Offer 接受',
  offer_rejected: 'Offer 拒绝', rollback: '异常回退'
}
const OFFER_FLOW = ['pending', 'accepted', 'joined']

// 可预期的业务异常：携带 HTTP 状态码与错误码，事务回滚后按 4xx 返回，前端可直接提示
class ApiError extends Error {
  constructor(status, code, msg) {
    super(msg)
    this.status = status
    this.code = code
  }
}
const badRequest = (msg, code = 'invalid') => { throw new ApiError(400, code, msg) }
const conflict = (msg, code = 'conflict') => { throw new ApiError(409, code, msg) }
const forbidden = (msg, code = 'forbidden') => { throw new ApiError(403, code, msg) }

// 危机处置模块回退执行器：在危机模块自己的事务内调用，豁免乐观锁版本（紧急处置可能面对过期页面），
// 但仍走与 /rollback 完全相同的状态机（撤回联动 Offer、rollback 阶段事件、淘汰复活）
function rollbackForIncident(applicationId, operatorName, reason) {
  const a = db.prepare('SELECT * FROM applications WHERE id=?').get(num(applicationId))
  if (!a) badRequest('关联应聘记录不存在', 'app_missing')
  const from = a.stage
  const offerBefore = offerOfApp(a.id)
  rollbackStage(a, { operator: operatorName, reason })
  if (a.stage === 'rejected') db.prepare("UPDATE applications SET reject_from='' WHERE id=?").run(a.id)
  const offerAfter = offerOfApp(a.id)
  return {
    from, to: a.stage,
    fromLabel: STAGE_LABEL[from] || from, toLabel: STAGE_LABEL[a.stage] || a.stage,
    version: a.version,
    offerWithdrawn: !!offerBefore && offerBefore.status !== 'withdrawn' && offerAfter?.status === 'withdrawn'
  }
}

// ---------------- 角色与审批链 ----------------
const ROLE_LABEL = { recruiter: '招聘负责人', interviewer: '面试官', hiring_manager: '用人经理' }
// 三类需审批的关键动作及其允许的发起角色；审批链在提交时按类型（+动态规则）固化
const TASK_TYPES = {
  stage_advance: { label: '候选人推进', submitRole: 'recruiter' },
  interview_conclusion: { label: '面试结论', submitRole: 'interviewer' },
  offer_issue: { label: 'Offer 发放', submitRole: 'recruiter' },
  strategy_publish: { label: '匹配策略发布', submitRole: 'recruiter' }
}

// 身份解析：前端每次请求带 x-user-id；缺省回退招聘负责人，保证旧调用兼容
function currentUser(req) {
  const id = String(req.headers['x-user-id'] || '')
  const u = id ? db.prepare('SELECT * FROM users WHERE id=?').get(id) : null
  return u || db.prepare("SELECT * FROM users WHERE role='recruiter' ORDER BY id LIMIT 1").get()
}

// 审批链规则：推进/结论为单级；Offer 发放由用人经理审批，薪资超职位带宽时自动加签招聘负责人终审
function buildChain(type, payload, app) {
  if (type === 'stage_advance') return [{ role: 'hiring_manager' }]
  if (type === 'interview_conclusion') return [{ role: 'recruiter' }]
  if (type === 'strategy_publish') return [{ role: 'hiring_manager' }]
  if (type === 'offer_issue') {
    const chain = [{ role: 'hiring_manager' }]
    const pos = db.prepare('SELECT salary_max FROM positions WHERE id=?').get(app.position_id)
    if (pos && num(payload.salary) > num(pos.salary_max)) {
      chain.push({ role: 'recruiter', reason: `月薪超职位带宽上限 ¥${num(pos.salary_max).toLocaleString()}，加签终审` })
    }
    return chain
  }
  return []
}

function addStep(taskId, { stepNo = -1, role = '', action, actor, note = '' }) {
  db.prepare(`INSERT INTO approval_steps(task_id,step_no,role,action,actor_id,actor_name,note,acted_at)
              VALUES(?,?,?,?,?,?,?,?)`)
    .run(taskId, stepNo, role, action, actor?.id || '', actor?.name || actor || '', note, ts())
}

// 审计通知：按接收角色投递，审批中心与顶栏铃铛共用同一数据源
function notify({ recipientRole, type, title, body, taskId = 0, appId = 0 }) {
  db.prepare(`INSERT INTO notifications(recipient_role,type,title,body,task_id,application_id,is_read,created_at)
              VALUES(?,?,?,?,?,?,0,?)`)
    .run(recipientRole, type, title, body, taskId, appId, ts())
}

// 乐观锁：阶段协同类操作必须携带读取时的 version；并发/重复点击导致版本错位时拒绝
function checkVersion(app, expected) {
  if (expected !== undefined && expected !== null && expected !== '' && num(expected) !== num(app.version)) {
    conflict('流程状态已被其他操作更新，请刷新后重试', 'version_conflict')
  }
}

function latestInterviewOf(applicationId) {
  return db.prepare('SELECT * FROM interviews WHERE application_id=? ORDER BY id DESC LIMIT 1').get(applicationId) || null
}

// 面试结论约束：进入 Offer 前，最近一轮必须已有「通过」结论（待定/不通过均拦截）
function assertCanEnterOffer(app) {
  const iv = latestInterviewOf(app.id)
  if (!iv) badRequest('请先安排并完成至少一轮面试', 'interview_required')
  const c = iv.conclusion || iv.result || 'pending'
  if (c === 'pending') badRequest(`最近一轮「${iv.round}」尚未给出面试结论，不能进入 Offer`, 'interview_pending')
  if (c === 'fail') badRequest(`最近一轮「${iv.round}」结论为不通过，不能进入 Offer；如需推进请先改判结论`, 'interview_failed')
}

function offerOfApp(applicationId) {
  return db.prepare('SELECT * FROM offers WHERE application_id=? ORDER BY id DESC LIMIT 1').get(applicationId) || null
}

function addOfferLog({ offerId, applicationId, changeType, of, toStatus, toSalary, operator = 'HR-Sandy', note = '' }) {
  db.prepare(`INSERT INTO offer_change_logs(offer_id,application_id,change_type,from_status,to_status,from_salary,to_salary,changed_at,operator,note)
              VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(offerId, applicationId, changeType,
      of?.status || '', toStatus ?? of?.status ?? '',
      num(of?.salary, 0), num(toSalary ?? of?.salary, 0),
      ts(), operator, note)
}

// ---------------- 人岗匹配评分算法 ----------------
// 系统默认五维权重合计闭合为 1.0；每个职位可发布自己的策略（match_strategies）
const WEIGHT_KEYS = ['skill', 'year', 'salary', 'edu', 'city']

// 把前端传入的权重归一化为合计 1.0；允许将某维权重设为 0（如不看学历）
function normalizeWeights(input) {
  const raw = {}
  WEIGHT_KEYS.forEach(k => { raw[k] = Math.max(0, num(input?.[k], DEFAULT_WEIGHTS[k])) })
  const total = WEIGHT_KEYS.reduce((s, k) => s + raw[k], 0)
  if (total <= 0) return { ...DEFAULT_WEIGHTS }
  // 先保留两位小数，再把舍入残差补到权重最大的维度，保证合计严格为 1
  const w = {}
  WEIGHT_KEYS.forEach(k => { w[k] = Math.round(raw[k] / total * 100) / 100 })
  let rest = Math.round((1 - WEIGHT_KEYS.reduce((s, k) => s + w[k], 0)) * 100) / 100
  if (rest !== 0) {
    const maxK = WEIGHT_KEYS.reduce((a, b) => w[b] > w[a] ? b : a, WEIGHT_KEYS[0])
    w[maxK] = Math.round((w[maxK] + rest) * 100) / 100
  }
  return w
}

// 读取指定策略版本（v0 表示系统默认/历史策略）
function getStrategyVersion(versionId) {
  const id = num(versionId)
  if (!id) return null
  const v = db.prepare('SELECT * FROM strategy_versions WHERE id=?').get(id)
  if (!v) return null
  return {
    ...v,
    keyword_cap: num(v.keyword_cap),
    canary_percent: num(v.canary_percent),
    base_version_id: num(v.base_version_id),
    rollback_of_version_id: num(v.rollback_of_version_id),
    approval_task_id: num(v.approval_task_id),
    weights: normalizeWeights(parseJSON(v.weights, { ...DEFAULT_WEIGHTS }))
  }
}

function strategyPayload(v, extra = {}) {
  const weights = v ? normalizeWeights(parseJSON(v.weights, { ...DEFAULT_WEIGHTS })) : { ...DEFAULT_WEIGHTS }
  return {
    positionId: extra.positionId || num(v?.position_id) || 0,
    weights,
    keywordCap: v ? Math.max(0, num(v.keyword_cap, DEFAULT_KEYWORD_CAP)) : DEFAULT_KEYWORD_CAP,
    versionId: v?.id || 0,
    status: v?.status || (v ? v.status : 'default'),
    publishedAt: v?.published_at || '',
    publishedBy: v?.published_by || '',
    activeAt: v?.active_at || '',
    canaryEndAt: v?.canary_end_at || '',
    expireAt: v?.expire_at || '',
    canaryPercent: v ? num(v.canary_percent) : 0,
    isDefault: !v,
    isStable: v ? !!num(v.is_stable) : true,
    isCanary: v ? !!num(v.is_canary) : false,
    baseVersionId: v?.base_version_id || 0,
    approvalTaskId: v?.approval_task_id || 0,
    changeNote: v?.change_note || '',
    ...extra
  }
}

function parseWindowTime(value, defaultNow = false) {
  if (value === undefined || value === null || value === '') return defaultNow ? now() : ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) badRequest('生效时间格式无效，请使用 ISO 或可解析的日期时间', 'invalid_time')
  return d.toISOString()
}

// 灰度名单在同一 position×candidate 上稳定：调整百分比不会让同一候选人来回抖动
function canaryBucket(posId, candId) {
  const key = `strategy-canary:${num(posId)}:${num(candId)}`
  let hash = 2166136261
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % 100
}

function inCanaryCohort(posId, candId, percent) {
  const p = Math.max(0, Math.min(100, num(percent)))
  return p >= 100 ? true : p > 0 && canaryBucket(posId, candId) < p
}

function getCurrentVersion(posId) {
  const row = db.prepare('SELECT * FROM match_strategies WHERE position_id=?').get(num(posId))
  if (!row || !row.current_version_id) return null
  const v = getStrategyVersion(row.current_version_id)
  const at = now()
  // 到期的稳定版本在 sweep 中会切换；为了兼容未启动 sweep 的请求，这里再做一次惰性判定
  if (v && v.expire_at && v.expire_at <= at) return null
  return v
}

// 读取职位当前生效策略；传 candidateId 时按稳定灰度路由选择版本。
// mode=canary/stable 可强制预览某一通道；snapshot 可复用历史投递/阶段快照。
function getStrategy(posId, options = {}) {
  const pid = num(posId)
  if (options.snapshot?.strategy_id !== undefined) {
    const v = getStrategyVersion(options.snapshot.strategy_id)
    if (v) {
      return strategyPayload(v, {
        positionId: pid,
        mode: options.snapshot.strategy_mode || (v.is_canary ? 'canary' : 'stable'),
        canaryPercent: num(options.snapshot.canary_percent ?? v.canary_percent),
        routedFromSnapshot: true
      })
    }
  }

  const row = db.prepare('SELECT * FROM match_strategies WHERE position_id=?').get(pid)
  const at = now()
  let stable = null, canary = null, expired = false
  if (row) {
    const current = row.current_version_id ? getStrategyVersion(row.current_version_id) : null
    expired = !!(current && current.expire_at && current.expire_at <= at)
    stable = expired ? null : current
    canary = row.canary_version_id ? getStrategyVersion(row.canary_version_id) : null
    if (canary && (canary.status !== 'canary' || (canary.active_at && canary.active_at > at) ||
      (canary.canary_end_at && canary.canary_end_at <= at))) canary = null
  }

  let selected = stable
  let mode = stable ? 'stable' : 'default'
  if (options.mode === 'canary' && canary) { selected = canary; mode = 'canary' }
  else if (options.mode === 'stable' && stable) { selected = stable; mode = 'stable' }
  else if (canary && options.candidateId !== undefined && options.candidateId !== null &&
    inCanaryCohort(pid, options.candidateId, canary.canary_percent)) {
    selected = canary
    mode = 'canary'
  }

  const payload = strategyPayload(selected, {
    positionId: pid,
    mode,
    canaryPercent: selected?.id === canary?.id ? num(canary.canary_percent) : (selected?.canary_percent || 0),
    canaryVersion: canary ? strategyPayload(canary, { positionId: pid, mode: 'canary' }) : null,
    stableVersion: stable ? strategyPayload(stable, { positionId: pid, mode: 'stable' }) : strategyPayload(null, { positionId: pid }),
    routedCanary: mode === 'canary'
  })
  if (options.candidateId !== undefined && options.candidateId !== null) {
    payload.candidate_id = num(options.candidateId)
    payload.bucket = canaryBucket(pid, options.candidateId)
  }
  return payload
}

function computeMatch(cand, pos, strategy) {
  const W = strategy?.weights || DEFAULT_WEIGHTS
  const keywordCap = strategy?.keywordCap ?? DEFAULT_KEYWORD_CAP
  const cSkills = parseSkills(cand.skills)
  const pSkills = parseSkills(pos.skills)
  const dims = []

  // 技能匹配：候选者命中职位要求技能的熟练度按职位权重加权
  let skillScore = 0, matched = 0, skillWeightSum = 0
  pSkills.forEach(req => {
    const hit = cSkills.find(c => c.k === req.k)
    if (hit) { skillScore += Math.min(100, (num(hit.idx, 3) / 5) * 100) * req.w; matched++ }
    skillWeightSum += req.w
  })
  const skillCover = pSkills.length ? matched / pSkills.length : 1
  skillScore = pSkills.length ? (skillWeightSum ? skillScore / skillWeightSum : 0) : 70
  dims.push({ k: '技能', score: Math.round(skillScore), w: W.skill })

  // 年限匹配
  const ideal = num(pos.years, 0)
  const yearScore = num(cand.years, 0) >= ideal ? 90 : Math.max(30, 100 - (ideal - num(cand.years, 0)) * 15)
  dims.push({ k: '经验年限', score: Math.round(yearScore), w: W.year })

  // 薪资带宽匹配（先判低于带宽，再判高于带宽，避免分支被吞）
  const sal = num(cand.exp_salary, 0)
  let salScore, salNote, salOver = false, salOverMuch = false
  if (sal <= 0) { salScore = 70; salNote = '期望薪资未填写' }
  else if (sal < pos.salary_min) { salScore = 75; salNote = '期望薪资低于带宽' }
  else if (sal <= pos.salary_max) { salScore = 90; salNote = '期望薪资在带宽内' }
  else if (sal <= pos.salary_max * 1.15) { salScore = 70; salNote = '期望薪资略高于带宽'; salOver = true }
  else { salScore = 45; salNote = '期望薪资超出带宽'; salOver = true; salOverMuch = true }
  dims.push({ k: '薪资匹配', score: salScore, w: W.salary })

  // 学历匹配
  const eduRank = { '博士': 100, '硕士': 85, '本科': 70, '大专': 55 }
  const eduScore = eduRank[cand.edu] ?? 65
  dims.push({ k: '学历', score: eduScore, w: W.edu })

  // 城市匹配
  const cityHit = pos.city === '全国' || (!!cand.city && cand.city === pos.city)
  const cityScore = cityHit ? 90 : 65
  dims.push({ k: '城市地点', score: cityScore, w: W.city })

  // 简历关键词加分（在职位名/要求技能中命中，封顶，不计入维度权重；cap=0 关闭）
  const keywords = new Set([...pSkills.map(s => s.k), ...String(pos.name || '').split(/[\s/、,，]+/).filter(Boolean)])
  const tokens = String(cand.raw || '').split(/[,，。；;、/\s]+/).filter(Boolean)
  const hitKws = new Set([...keywords].filter(kw => tokens.some(t => t.includes(kw))))
  const keywordBonus = Math.min(keywordCap, hitKws.size * 1.5)

  // 五维加权（权重按职位策略，合计 1.0）+ 封顶关键词附加分
  const base = skillScore * W.skill
    + yearScore * W.year
    + salScore * W.salary
    + eduScore * W.edu
    + cityScore * W.city
  const score = Math.min(100, Math.round(base + keywordBonus))

  // 短板：覆盖技能/年限/薪资/学历/城市五个维度
  const weakness = []
  if (skillCover < 0.5) weakness.push('关键技能覆盖不足')
  if (yearScore < 65) weakness.push('经验年限偏低')
  if (salOverMuch) weakness.push('期望薪资超出带宽')
  else if (salOver) weakness.push('期望薪资略高于带宽')
  if (eduScore < 60) weakness.push('学历相对偏低')
  if (!cityHit) weakness.push('工作城市不匹配')

  const rating = score >= 80 ? '高匹配' : score >= 65 ? '匹配度良好' : score >= 55 ? '基本匹配' : '匹配度偏低'
  const cityNote = cityHit
    ? (pos.city === '全国' ? '城市全国可选' : `城市${cand.city}与职位一致`)
    : `城市${cand.city || '未知'}≠${pos.city}`
  const reason = [
    `技能覆盖${Math.round(skillCover * 100)}%`,
    `经验${cand.years}/${ideal}年`,
    salNote,
    `${cand.edu || '学历未知'}`,
    cityNote
  ].join('，') + `；综合${rating}${keywordBonus ? `（简历关键词+${keywordBonus.toFixed(1)}分）` : ''}`

  return { score, dims, reason, weakness: weakness.join('、') || '无显著短板' }
}

// 计算评分但不落库：推荐列表浏览不隐式制造“最新结果”，避免与流程推进时看到的证据不一致
function computePair(candId, posId, strategy = getStrategy(posId, { candidateId: candId }), opts = {}) {
  candId = num(candId); posId = num(posId)
  const cand = db.prepare('SELECT * FROM candidates WHERE id=?').get(candId)
  const pos = db.prepare('SELECT * FROM positions WHERE id=?').get(posId)
  if (!cand || !pos) return null
  const m = computeMatch(cand, pos, strategy)
  return {
    ...m,
    candidate_id: candId,
    position_id: posId,
    weights: strategy.weights,
    keyword_cap: strategy.keywordCap,
    strategy_id: strategy.versionId,
    strategy_is_default: strategy.isDefault,
    strategy_status: strategy.status,
    strategy_mode: strategy.mode || (strategy.isCanary ? 'canary' : strategy.versionId ? 'stable' : 'default'),
    canary_percent: num(strategy.canaryPercent ?? strategy.canary_percent ?? 0),
    canary_bucket: strategy.bucket ?? canaryBucket(posId, candId),
    in_canary: strategy.routedCanary || strategy.mode === 'canary',
    active_at: strategy.activeAt || '',
    expire_at: strategy.expireAt || '',
    computed_at: now(),
    ...opts
  }
}

function createRecalcJob({
  triggerType, scope, positionId = 0, strategyId = 0, baseStrategyId = 0,
  strategyMode = 'stable', canaryPercent = 0, triggeredBy = 'HR'
}) {
  const stamp = ts()
  const r = db.prepare(`INSERT INTO recalc_jobs(trigger_type,scope,position_id,strategy_id,base_strategy_id,strategy_mode,canary_percent,status,pair_count,started_at,finished_at,triggered_by)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(triggerType, scope, num(positionId), num(strategyId), num(baseStrategyId),
      strategyMode, num(canaryPercent), 'running', 0, stamp, stamp, triggeredBy)
  return Number(r.lastInsertRowid)
}

function completeRecalcJob(jobId, pairCount) {
  db.prepare('UPDATE recalc_jobs SET status=?, pair_count=?, finished_at=? WHERE id=?')
    .run('completed', pairCount, ts(), jobId)
}

// 按指定策略/灰度通道重算并落库为「最新结果」（不影响 applications/events 中的历史快照）。
// 稳定批次会更新该 pair 的最新分；灰度批次额外保存明细，但仅当该 pair 命中灰度桶时更新最新分。
function upsertMatch(candId, posId, jobId = 0, opts = {}) {
  posId = num(posId); candId = num(candId)
  const forceStrategy = opts.strategy || null
  const mode = opts.mode || forceStrategy?.mode || (forceStrategy?.isCanary ? 'canary' : 'stable')
  const canaryPercent = num(opts.canaryPercent ?? forceStrategy?.canaryPercent ?? forceStrategy?.canary_percent ?? 0)
  const strategy = forceStrategy || getStrategy(posId, {
    candidateId: candId,
    mode: mode === 'canary' ? undefined : mode
  })
  const routedCanary = mode === 'canary' || strategy.routedCanary
  const inCanary = opts.inCanary !== undefined
    ? !!opts.inCanary
    : (mode === 'canary' ? true : !!routedCanary)
  const m = computePair(candId, posId, strategy, {
    strategy_mode: routedCanary ? 'canary' : mode,
    canary_percent: canaryPercent,
    in_canary: inCanary
  })
  if (!m) return null
  const stamp = m.computed_at
  const jid = num(jobId)
  const existing = db.prepare('SELECT id FROM matches WHERE candidate_id=? AND position_id=?').get(candId, posId)
  if (existing) {
    db.prepare(`UPDATE matches SET score=?,dims=?,reason=?,weakness=?,computed_at=?,strategy_id=?,strategy_mode=?,canary_percent=? WHERE id=?`)
      .run(m.score, JSON.stringify(m.dims), m.reason, m.weakness, stamp, m.strategy_id,
        routedCanary ? 'canary' : mode, canaryPercent, existing.id)
  } else {
    db.prepare(`INSERT INTO matches(candidate_id,position_id,score,dims,reason,weakness,computed_at,strategy_id,strategy_mode,canary_percent)
                VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(candId, posId, m.score, JSON.stringify(m.dims), m.reason, m.weakness, stamp,
        m.strategy_id, routedCanary ? 'canary' : mode, canaryPercent)
  }
  if (jid) {
    db.prepare(`INSERT INTO recalc_items(job_id,candidate_id,position_id,strategy_id,strategy_mode,canary_percent,in_canary,score,dims,reason,weakness,computed_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(jid, candId, posId, m.strategy_id, routedCanary ? 'canary' : mode, canaryPercent,
        inCanary ? 1 : 0, m.score, JSON.stringify(m.dims), m.reason, m.weakness, stamp)
  }
  return { ...m, recalc_job_id: jid, in_canary: inCanary }
}

// 投递/进入阶段时的评分依据快照：锁定分数、维度、理由、短板、生效窗口及灰度通道，后续重算不再改变
function buildSnapshot(candId, posId, m, extra = {}) {
  const strategy = m && (m.weights || m.strategy_id !== undefined)
    ? {
        weights: m.weights,
        keywordCap: m.keyword_cap,
        versionId: m.strategy_id,
        isDefault: m.strategy_id ? m.strategy_is_default === true : true,
        publishedAt: m.published_at || '',
        publishedBy: m.published_by || '',
        activeAt: m.active_at || '',
        expireAt: m.expire_at || '',
        canaryPercent: m.canary_percent || 0,
        mode: m.strategy_mode
      }
    : getStrategy(posId, { candidateId: candId })
  const mode = extra.strategy_mode || strategy.mode || (strategy.versionId ? 'stable' : 'default')
  return {
    score: m.score, dims: m.dims, reason: m.reason, weakness: m.weakness,
    weights: strategy.weights, keyword_cap: strategy.keywordCap,
    strategy_id: strategy.versionId, strategy_is_default: strategy.isDefault,
    strategy_mode: mode,
    canary_percent: num(strategy.canaryPercent ?? strategy.canary_percent ?? 0),
    canary_bucket: m.canary_bucket ?? canaryBucket(posId, candId),
    in_canary: mode === 'canary',
    published_at: strategy.publishedAt, published_by: strategy.publishedBy,
    active_at: strategy.activeAt || '', expire_at: strategy.expireAt || '',
    candidate_id: candId, position_id: posId,
    matched_at: now(),
    ...extra
  }
}

// ---------------- 策略版本治理：审批 / 生效窗口 / 灰度 / 转正 / 回滚 ----------------
function addStrategyEvent(version, action, { actor = '', note = '', detail = {}, approvalTaskId = 0, recalcJobId = 0, fromStatus, toStatus } = {}) {
  db.prepare(`INSERT INTO strategy_version_events(version_id,position_id,action,from_status,to_status,actor,note,detail,approval_task_id,recalc_job_id,event_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(version.id, version.position_id, action, fromStatus ?? version.status, toStatus ?? version.status,
      actor, note, JSON.stringify(detail), num(approvalTaskId), num(recalcJobId), ts())
}

function versionRow(id, { posId = 0, allowStatuses = [] } = {}) {
  const v = id ? db.prepare('SELECT * FROM strategy_versions WHERE id=?').get(num(id)) : null
  if (!v || (posId && v.position_id !== num(posId))) badRequest('策略版本不存在或不属于该职位', 'strategy_version_missing')
  if (allowStatuses.length && !allowStatuses.includes(v.status)) {
    conflict(`策略版本当前状态为「${v.status}」，不能执行该操作`, 'strategy_status_invalid')
  }
  return v
}

function assertNoInFlightStrategy(posId, ignoreVersionId = 0) {
  const rows = db.prepare(`SELECT id,status FROM strategy_versions
                           WHERE position_id=? AND id!=? AND status IN ('pending_approval','scheduled','canary')`).all(num(posId), num(ignoreVersionId))
  if (rows.length) {
    const label = { pending_approval: '待审批', scheduled: '待生效', canary: '灰度中' }[rows[0].status]
    conflict(`该职位已有${label}版本 v${rows[0].id}，请先审批、取消、转正或回滚后再发布`, 'strategy_in_flight')
  }
}

function upsertStrategyPointer(posId, { currentId, canaryId, stableId, weights, keywordCap, publishedAt, publishedBy }) {
  const exists = db.prepare('SELECT position_id FROM match_strategies WHERE position_id=?').get(num(posId))
  const stamp = ts()
  if (exists) {
    db.prepare(`UPDATE match_strategies
                SET current_version_id=?, canary_version_id=?, stable_version_id=?,
                    weights=?, keyword_cap=?, published_at=?, published_by=?, updated_at=?
                WHERE position_id=?`)
      .run(num(currentId), num(canaryId), num(stableId), JSON.stringify(weights),
        num(keywordCap), publishedAt, publishedBy, stamp, num(posId))
  } else {
    db.prepare(`INSERT INTO match_strategies(position_id,weights,keyword_cap,published_at,published_by,current_version_id,canary_version_id,stable_version_id,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(num(posId), JSON.stringify(weights), num(keywordCap), publishedAt, publishedBy,
        num(currentId), num(canaryId), num(stableId), stamp)
  }
}

function clearStrategyPointer(posId) {
  db.prepare(`UPDATE match_strategies
              SET current_version_id=0, canary_version_id=0, stable_version_id=0,
                  weights='{}', keyword_cap=?, published_at='', published_by='系统', updated_at=?
              WHERE position_id=?`).run(DEFAULT_KEYWORD_CAP, ts(), num(posId))
}

// 重算某职位。灰度版本发布时稳定与灰度两条通道都写批次明细；matches 仅反映当前路由结果。
function recomputePositionWithChannels(posId, { canaryVersion = null, stableVersion = null, triggerType = 'manual', triggeredBy = 'HR', note = '' } = {}) {
  const row = db.prepare('SELECT * FROM match_strategies WHERE position_id=?').get(posId)
  const stable = stableVersion !== undefined ? stableVersion : (row ? getStrategyVersion(row.stable_version_id || row.current_version_id) : getCurrentVersion(posId))
  const canary = canaryVersion !== undefined ? canaryVersion : (row?.canary_version_id ? getStrategyVersion(row.canary_version_id) : null)
  const cands = db.prepare('SELECT id FROM candidates ORDER BY id').all()
  const stableStrategy = stable ? strategyPayload(stable, { positionId: posId, mode: 'stable' }) : strategyPayload(null, { positionId: posId, mode: 'default' })
  const canaryStrategy = canary ? strategyPayload(canary, { positionId: posId, mode: 'canary' }) : null

  if (canaryStrategy) {
    const jobId = createRecalcJob({
      triggerType, scope: 'canary', positionId: posId, strategyId: canary.id,
      baseStrategyId: stable?.id || 0, strategyMode: 'canary', canaryPercent: canary.canary_percent,
      triggeredBy
    })
    let canaryHits = 0
    cands.forEach(c => {
      const hit = inCanaryCohort(posId, c.id, canary.canary_percent)
      if (hit) {
        upsertMatch(c.id, posId, jobId, { strategy: canaryStrategy, mode: 'canary', inCanary: true })
        canaryHits++
      } else {
        // 灰度外候选人仍按稳定版本刷新最新分；在灰度明细中标记 in_canary=0 便于报表对比覆盖率
        upsertMatch(c.id, posId, jobId, { strategy: stableStrategy, mode: 'stable', canaryPercent: canary.canary_percent, inCanary: false })
      }
    })
    completeRecalcJob(jobId, cands.length)
    return { jobId, pairs: canaryHits, processed: cands.length, total: cands.length, canary: true }
  }

  const jobId = createRecalcJob({
    triggerType, scope: 'position', positionId: posId, strategyId: stable?.id || 0,
    strategyMode: stable ? 'stable' : 'default', triggeredBy
  })
  cands.forEach(c => upsertMatch(c.id, posId, jobId, { strategy: stableStrategy, mode: stable ? 'stable' : 'default' }))
  completeRecalcJob(jobId, cands.length)
  return { jobId, pairs: cands.length, total: cands.length, canary: false }
}

function activateScheduledVersion(v, actor = 'system-sweep', note = '到达生效窗口自动生效') {
  const posId = v.position_id
  const weights = normalizeWeights(parseJSON(v.weights, { ...DEFAULT_WEIGHTS }))
  const canary = num(v.canary_percent) > 0 && num(v.canary_percent) < 100
  const newStatus = canary ? 'canary' : 'active'
  const base = db.prepare('SELECT current_version_id, stable_version_id, canary_version_id FROM match_strategies WHERE position_id=?').get(posId)
  const stableId = base?.stable_version_id || base?.current_version_id || 0
  const baseVersion = stableId ? getStrategyVersion(stableId) : null
  db.prepare(`UPDATE strategy_versions SET status=?, is_canary=?, is_stable=?, base_version_id=COALESCE(NULLIF(base_version_id,0),?), updated_at=? WHERE id=?`)
    .run(newStatus, canary ? 1 : 0, canary ? 0 : 1, stableId, ts(), v.id)
  if (canary) {
    const current = stableId ? getStrategyVersion(stableId) : null
    upsertStrategyPointer(posId, {
      currentId: stableId, canaryId: v.id, stableId,
      weights: current ? normalizeWeights(parseJSON(current.weights, { ...DEFAULT_WEIGHTS })) : DEFAULT_WEIGHTS,
      keywordCap: current?.keyword_cap ?? DEFAULT_KEYWORD_CAP,
      publishedAt: current?.published_at || '', publishedBy: current?.published_by || '系统默认'
    })
  } else {
    db.prepare("UPDATE strategy_versions SET status='retired', is_stable=0, is_canary=0, updated_at=? WHERE position_id=? AND id!=? AND status IN ('active','canary')")
      .run(ts(), posId, v.id)
    upsertStrategyPointer(posId, {
      currentId: v.id, canaryId: 0, stableId: v.id, weights,
      keywordCap: v.keyword_cap, publishedAt: v.published_at, publishedBy: v.published_by
    })
  }
  const updated = getStrategyVersion(v.id)
  let jobId = 0, pairs = 0
  if (num(v.recalc_on_activate) !== 0) {
    const r = recomputePositionWithChannels(posId, {
      canaryVersion: canary ? updated : null,
      stableVersion: canary ? (baseVersion || null) : updated,
      triggerType: 'strategy_activate', triggeredBy: actor, note
    })
    jobId = r.jobId; pairs = r.pairs
  }
  addStrategyEvent(updated, canary ? 'canary_start' : 'activate', {
    actor, note, fromStatus: v.status, toStatus: newStatus, approvalTaskId: v.approval_task_id, recalcJobId: jobId,
    detail: { canary_percent: v.canary_percent, base_version_id: stableId, pairs }
  })
  return { version: updated, jobId, pairs }
}

function promoteCanaryVersion(versionId, { actor, note = '' } = {}) {
  const v = versionRow(versionId, { allowStatuses: ['canary'] })
  const posId = v.position_id
  const weights = normalizeWeights(parseJSON(v.weights, { ...DEFAULT_WEIGHTS }))
  db.prepare("UPDATE strategy_versions SET status='retired', is_stable=0, is_canary=0, updated_at=? WHERE position_id=? AND id!=? AND status IN ('active','canary','canary_ended')")
    .run(ts(), posId, v.id)
  db.prepare("UPDATE strategy_versions SET status='active', is_stable=1, is_canary=0, canary_percent=100, updated_at=? WHERE id=?")
    .run(ts(), v.id)
  upsertStrategyPointer(posId, {
    currentId: v.id, canaryId: 0, stableId: v.id, weights,
    keywordCap: v.keyword_cap, publishedAt: v.published_at, publishedBy: v.published_by
  })
  const updated = getStrategyVersion(v.id)
  const rec = recomputePositionWithChannels(posId, {
    canaryVersion: null, stableVersion: updated, triggerType: 'strategy_promote', triggeredBy: actor, note
  })
  addStrategyEvent(updated, 'promote', {
    actor, note, fromStatus: v.status, toStatus: 'active', recalcJobId: rec.jobId,
    detail: { pairs: rec.pairs, canary_percent: 100 }
  })
  return { version: updated, ...rec }
}

function endCanaryVersion(versionId, { actor, note = '' } = {}) {
  const v = versionRow(versionId, { allowStatuses: ['canary'] })
  const posId = v.position_id
  const stableId = num(v.base_version_id)
  const stable = stableId ? getStrategyVersion(stableId) : null
  db.prepare("UPDATE strategy_versions SET status='canary_ended', is_canary=0, is_stable=0, updated_at=? WHERE id=?")
    .run(ts(), v.id)
  upsertStrategyPointer(posId, {
    currentId: stableId, canaryId: 0, stableId,
    weights: stable ? normalizeWeights(parseJSON(stable.weights, { ...DEFAULT_WEIGHTS })) : DEFAULT_WEIGHTS,
    keywordCap: stable?.keyword_cap ?? DEFAULT_KEYWORD_CAP,
    publishedAt: stable?.published_at || '', publishedBy: stable?.published_by || '系统默认'
  })
  const rec = recomputePositionWithChannels(posId, {
    canaryVersion: null, stableVersion: stable, triggerType: 'strategy_rollback', triggeredBy: actor, note
  })
  addStrategyEvent({ ...v, status: 'canary_ended' }, 'canary_end', {
    actor, note, fromStatus: 'canary', toStatus: 'canary_ended', recalcJobId: rec.jobId,
    detail: { restored_version_id: stableId, pairs: rec.pairs }
  })
  return { version: getStrategyVersion(v.id), ...rec }
}

function createRollbackVersion(posId, { actor = 'HR', note = '', reason = '', immediate = true, versionId = 0 }) {
  // 紧急回滚优先级高于尚未生效/待审批的发布：统一取消在途版本，避免回滚后又被旧申请覆盖
  db.prepare(`SELECT * FROM strategy_versions WHERE position_id=? AND status IN ('pending_approval','scheduled','canary') ORDER BY id`)
    .all(num(posId)).forEach(v => {
      const newStatus = 'cancelled'
      db.prepare("UPDATE strategy_versions SET status=?, is_canary=0, is_stable=0, updated_at=? WHERE id=?").run(newStatus, ts(), v.id)
      if (v.approval_task_id) {
        const t = db.prepare('SELECT * FROM approval_tasks WHERE id=?').get(v.approval_task_id)
        if (t && t.status === 'pending') {
          db.prepare("UPDATE approval_tasks SET status='cancelled', decided_at=?, result_note=?, version=version+1 WHERE id=?")
            .run(ts(), `策略紧急回滚，联动取消任务 #${t.id}`, t.id)
          addStep(t.id, { stepNo: -1, role: t.submitted_role, action: 'cancel', actor: { id: t.submitted_by, name: actor }, note: '策略紧急回滚，联动撤销审批' })
        }
      }
      addStrategyEvent({ ...v, status: newStatus }, 'cancel', {
        actor, note: `策略紧急回滚联动取消：${note || reason}`, approvalTaskId: v.approval_task_id,
        fromStatus: v.status, toStatus: newStatus
      })
    })
  const target = versionId ? getStrategyVersion(versionId) : getStrategyVersion(db.prepare('SELECT stable_version_id,current_version_id FROM match_strategies WHERE position_id=?').get(posId)?.stable_version_id)
  const row = db.prepare('SELECT * FROM match_strategies WHERE position_id=?').get(posId)
  const currentCanary = row?.canary_version_id ? getStrategyVersion(row.canary_version_id) : null
  const currentStable = row?.current_version_id ? getStrategyVersion(row.current_version_id) : null
  if (currentCanary && currentCanary.status === 'canary') {
    db.prepare("UPDATE strategy_versions SET status='rolled_back', is_canary=0, is_stable=0, updated_at=? WHERE id=?").run(ts(), currentCanary.id)
  }
  if (currentStable && target?.id !== currentStable.id) {
    db.prepare("UPDATE strategy_versions SET status='retired', is_stable=0, is_canary=0, updated_at=? WHERE id=?").run(ts(), currentStable.id)
  }

  const stamp = ts()
  const iso = now()
  const weights = target ? normalizeWeights(parseJSON(target.weights, { ...DEFAULT_WEIGHTS })) : { ...DEFAULT_WEIGHTS }
  const keywordCap = target?.keyword_cap ?? DEFAULT_KEYWORD_CAP
  const r = db.prepare(`INSERT INTO strategy_versions(position_id,weights,keyword_cap,published_at,published_by,status,active_at,canary_end_at,expire_at,canary_percent,is_stable,is_canary,base_version_id,rollback_of_version_id,recalc_on_activate,change_note,created_at,updated_at)
                        VALUES(?,?,?,?,?, 'active', ?, '', '', 0,1,0,?,?,1,?,?,?)`)
    .run(posId, JSON.stringify(weights), keywordCap, stamp, actor, iso,
      target?.id || 0, currentCanary?.id || currentStable?.id || 0, note || reason || '灰度回滚', stamp, stamp)
  const newId = Number(r.lastInsertRowid)
  upsertStrategyPointer(posId, {
    currentId: target ? newId : 0, canaryId: 0, stableId: target ? newId : 0,
    weights, keywordCap, publishedAt: stamp, publishedBy: actor
  })
  const created = getStrategyVersion(newId)
  const rec = recomputePositionWithChannels(posId, {
    canaryVersion: null, stableVersion: target ? created : null,
    triggerType: 'strategy_rollback', triggeredBy: actor, note
  })
  addStrategyEvent(created, 'rollback', {
    actor, note: note || reason, fromStatus: currentCanary ? 'canary' : (currentStable?.status || 'default'),
    toStatus: 'active', recalcJobId: rec.jobId,
    detail: { target_version_id: target?.id || 0, rolled_back_version_id: currentCanary?.id || currentStable?.id || 0, pairs: rec.pairs }
  })
  return { version: created, ...rec }
}

function expireStableVersion(v) {
  const posId = v.position_id
  db.prepare("UPDATE strategy_versions SET status='retired', is_stable=0, is_canary=0, updated_at=? WHERE id=?").run(ts(), v.id)
  let target = v.base_version_id ? getStrategyVersion(v.base_version_id) : null
  if (!target || !['active', 'canary'].includes(target.status)) {
    target = db.prepare(`SELECT * FROM strategy_versions WHERE position_id=? AND status='active' AND id!=?
                         ORDER BY id DESC LIMIT 1`).get(posId, v.id) || null
  }
  const pointer = db.prepare('SELECT canary_version_id FROM match_strategies WHERE position_id=?').get(posId)
  const canaryId = pointer?.canary_version_id || 0
  let targetId = target?.id || 0
  if (targetId) {
    db.prepare("UPDATE strategy_versions SET status='active', is_stable=1, is_canary=0, updated_at=? WHERE id=?").run(ts(), targetId)
    upsertStrategyPointer(posId, {
      currentId: targetId, canaryId, stableId: targetId,
      weights: normalizeWeights(parseJSON(target.weights, { ...DEFAULT_WEIGHTS })),
      keywordCap: target.keyword_cap, publishedAt: target.published_at, publishedBy: target.published_by
    })
  } else {
    db.prepare(`UPDATE match_strategies
                SET current_version_id=0, stable_version_id=0, canary_version_id=?,
                    weights='{}', keyword_cap=?, published_at='', published_by='系统', updated_at=?
                WHERE position_id=?`).run(canaryId, DEFAULT_KEYWORD_CAP, ts(), posId)
  }
  const rec = recomputePositionWithChannels(posId, {
    canaryVersion: null, stableVersion: target, triggerType: 'strategy_rollback', triggeredBy: 'system-expire'
  })
  addStrategyEvent({ ...v, status: 'retired' }, 'expire', {
    actor: 'system-sweep', note: '生效窗口结束，自动恢复上一稳定/默认策略',
    fromStatus: 'active', toStatus: 'retired', recalcJobId: rec.jobId,
    detail: { restored_version_id: targetId, pairs: rec.pairs }
  })
  return rec
}

function approveStrategyVersion(task, actor) {
  const v = db.prepare('SELECT * FROM strategy_versions WHERE id=?').get(num(task.strategy_version_id))
  if (!v || v.position_id !== num(task.position_id)) badRequest('关联策略版本不存在', 'strategy_version_missing')
  if (v.status !== 'pending_approval') badRequest(`策略版本当前为「${v.status}」，审批结果无法生效`, 'strategy_status_invalid')
  if (v.active_at && v.active_at <= now()) {
    addStrategyEvent(v, 'approve', {
      actor: actor.name, note: '终审通过并立即执行发布', approvalTaskId: task.id,
      fromStatus: 'pending_approval', toStatus: v.status
    })
    return activateScheduledVersion(v, actor.name, '审批通过并执行发布')
  }
  db.prepare("UPDATE strategy_versions SET status='scheduled', approval_task_id=COALESCE(NULLIF(approval_task_id,0),?), updated_at=? WHERE id=?").run(task.id, ts(), v.id)
  addStrategyEvent({ ...v, status: 'scheduled', approval_task_id: v.approval_task_id || task.id }, 'approve', {
    actor: actor.name, note: '审批通过，等待生效窗口', approvalTaskId: task.id,
    fromStatus: 'pending_approval', toStatus: 'scheduled'
  })
  return { version: getStrategyVersion(v.id), jobId: 0, pairs: 0 }
}

function runStrategySweep({ actor = 'system-sweep', manual = false } = {}) {
  const at = now()
  const activated = [], expired = [], canaryEnded = []
  db.prepare("SELECT * FROM strategy_versions WHERE status='scheduled' AND active_at!='' AND active_at<=? ORDER BY id")
    .all(at).forEach(v => activated.push(activateScheduledVersion(v, actor, manual ? '手动执行定时生效' : '到达生效窗口自动生效').version.id))
  db.prepare("SELECT * FROM strategy_versions WHERE status='canary' AND canary_end_at!='' AND canary_end_at<=? ORDER BY id")
    .all(at).forEach(v => { endCanaryVersion(v.id, { actor, note: '灰度观察窗口到期，自动结束灰度' }); canaryEnded.push(v.id) })
  db.prepare("SELECT * FROM strategy_versions WHERE status='active' AND expire_at!='' AND expire_at<=? ORDER BY id")
    .all(at).forEach(v => { expireStableVersion(v); expired.push(v.id) })
  return { ok: true, at, activated, expired, canary_ended: canaryEnded }
}

app.get('/api/state', (req, res) => {
  const positions = db.prepare('SELECT * FROM positions ORDER BY id').all().map(p => {
    const strategy = getStrategy(p.id)
    return {
      ...p,
      skills: parseSkills(p.skills),
      strategy: strategy.versionId
        ? { published_at: strategy.publishedAt, published_by: strategy.publishedBy, version_id: strategy.versionId, status: strategy.status }
        : null,
      strategyGovernance: strategy
    }
  })
  const candidates = db.prepare('SELECT * FROM candidates ORDER BY id').all().map(c => ({ ...c, skills: parseSkills(c.skills) }))
  const apps = db.prepare('SELECT * FROM applications ORDER BY id DESC').all()
  const interviews = db.prepare('SELECT * FROM interviews ORDER BY id DESC').all()
  const offers = db.prepare('SELECT * FROM offers ORDER BY id DESC').all()
  const offerLogs = db.prepare('SELECT * FROM offer_change_logs ORDER BY id ASC').all().map(l => ({
    ...l,
    from_salary: num(l.from_salary),
    to_salary: num(l.to_salary),
    change_label: {
      create: '发起 Offer', update_salary: '调整薪资', update_due: '调整期限',
      accept: '候选人接受', reject: '候选人拒绝', join: '确认入职',
      withdraw: '撤回 Offer', reopen: '重新发起'
    }[l.change_type] || l.change_type
  }))
  const channels = db.prepare('SELECT * FROM channels ORDER BY id').all()
  const strategyVersions = db.prepare('SELECT * FROM strategy_versions ORDER BY id DESC').all().map(v => ({
    ...v,
    weights: parseJSON(v.weights, { ...DEFAULT_WEIGHTS }),
    keyword_cap: num(v.keyword_cap),
    canary_percent: num(v.canary_percent),
    base_version_id: num(v.base_version_id),
    rollback_of_version_id: num(v.rollback_of_version_id),
    approval_task_id: num(v.approval_task_id),
    is_stable: !!num(v.is_stable),
    is_canary: !!num(v.is_canary)
  }))
  const strategyEvents = db.prepare('SELECT * FROM strategy_version_events ORDER BY id DESC LIMIT 1000').all().map(e => ({
    ...e,
    approval_task_id: num(e.approval_task_id),
    recalc_job_id: num(e.recalc_job_id),
    detail: parseJSON(e.detail, {})
  }))
  const recalcJobs = db.prepare('SELECT * FROM recalc_jobs ORDER BY id DESC').all().map(j => ({
    ...j,
    position_id: num(j.position_id),
    strategy_id: num(j.strategy_id),
    base_strategy_id: num(j.base_strategy_id),
    canary_percent: num(j.canary_percent),
    pair_count: num(j.pair_count)
  }))
  const recalcItems = db.prepare('SELECT id,job_id,candidate_id,position_id,strategy_id,strategy_mode,canary_percent,in_canary,score,computed_at FROM recalc_items ORDER BY id DESC LIMIT 500')
    .all().map(i => ({
      ...i,
      strategy_id: num(i.strategy_id),
      canary_percent: num(i.canary_percent),
      in_canary: !!num(i.in_canary),
      score: num(i.score)
    }))
  const appEvents = db.prepare('SELECT * FROM application_events ORDER BY id ASC').all().map(e => ({
    ...e,
    from_stage: e.from_stage || '',
    match_score: num(e.match_score),
    strategy_id: num(e.strategy_id),
    strategy_mode: e.strategy_mode || 'stable',
    canary_percent: num(e.canary_percent),
    recalc_job_id: num(e.recalc_job_id),
    backfilled: !!e.backfilled,
    stage_label: { submitted: '投递', screening: '筛选', interview: '面试', offer: 'Offer', hired: '录用', rejected: '淘汰' }[e.stage] || e.stage,
    scoreSnapshot: parseJSON(e.score_snapshot, null)
  }))
  const jobOf = new Map(recalcJobs.map(j => [j.id, j]))
  const matches = db.prepare('SELECT * FROM matches ORDER BY id DESC').all().map(m => ({
    ...m,
    score: num(m.score),
    dims: parseDims(m.dims, '[]'),
    strategy_id: num(m.strategy_id),
    strategy_mode: m.strategy_mode || 'stable',
    canary_percent: num(m.canary_percent)
  }))
  // 审批中心数据：任务 + 提交时固化的审批链 + 全程步骤留痕；通知按角色投递
  const users = db.prepare('SELECT * FROM users ORDER BY rowid').all()
  const approvalSteps = db.prepare('SELECT * FROM approval_steps ORDER BY id ASC').all()
  const approvals = db.prepare('SELECT * FROM approval_tasks ORDER BY id DESC').all().map(t => {
    const a = apps.find(x => x.id === t.application_id)
    const pos = a ? positions.find(p => p.id === a.position_id) : positions.find(p => p.id === t.position_id)
    const cand = a ? candidates.find(c => c.id === a.candidate_id) : null
    const sv = t.strategy_version_id ? strategyVersions.find(v => v.id === num(t.strategy_version_id)) : null
    return {
      ...t,
      application_id: num(t.application_id),
      position_id: num(t.position_id),
      strategy_version_id: num(t.strategy_version_id),
      payload: parseJSON(t.payload, {}),
      chain: parseJSON(t.chain, []),
      steps: approvalSteps.filter(s => s.task_id === t.id),
      candidate: cand ? cand.name : (t.type === 'strategy_publish' ? '策略发布' : ''),
      position: pos ? pos.name : '',
      dept: pos ? pos.dept : '',
      app_stage: a ? a.stage : '',
      strategy_version: sv ? {
        id: sv.id, canary_percent: sv.canary_percent, status: sv.status,
        active_at: sv.active_at, canary_end_at: sv.canary_end_at, expire_at: sv.expire_at,
        change_note: sv.change_note
      } : null,
      type_label: TASK_TYPES[t.type]?.label || t.type
    }
  })
  const notifications = db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 300').all()
    .map(n => ({ ...n, is_read: !!n.is_read }))
  const latestItemOf = (cid, pid) => db.prepare(`SELECT ri.* FROM recalc_items ri
    WHERE ri.candidate_id=? AND ri.position_id=? ORDER BY ri.id DESC LIMIT 1`).get(cid, pid) || null
  const matchOf = (cid, pid) => matches.find(m => m.candidate_id === cid && m.position_id === pid) || null
  const pipelines = apps.map(a => {
    const pos = positions.find(p => p.id === a.position_id)
    const cand = candidates.find(c => c.id === a.candidate_id)
    const its = interviews.filter(i => i.application_id === a.id)
    const of = offers.find(o => o.application_id === a.id) || null
    const mt = matchOf(a.candidate_id, a.position_id)
    const latestItem = latestItemOf(a.candidate_id, a.position_id)
    const latestJob = latestItem ? (jobOf.get(latestItem.job_id) || null) : null
    // 投递时锁定的历史评分依据；兼容旧数据：无快照时置空由前端回退最新分
    const snap = parseJSON(a.match_snapshot, null)
    const stageSnap = parseJSON(a.stage_snapshot, null)
    const latest = mt ? {
      score: mt.score, dims: mt.dims, reason: mt.reason, weakness: mt.weakness,
      computed_at: mt.computed_at, strategy_id: mt.strategy_id,
      recalc_job_id: latestItem?.job_id || 0,
      recalc_trigger: latestJob?.trigger_type || '',
      recalc_scope: latestJob?.scope || ''
    } : null
    return {
      ...a,
      version: num(a.version),
      strategy_mode: a.strategy_mode || snap?.strategy_mode || stageSnap?.strategy_mode || 'stable',
      strategy_version_id: num(a.strategy_version_id || snap?.strategy_id || stageSnap?.strategy_id || 0),
      canary_percent: num(a.canary_percent || snap?.canary_percent || stageSnap?.canary_percent || 0),
      position: pos ? pos.name : '', dept: pos ? pos.dept : '', city: pos ? pos.city : '',
      candidate: cand ? cand.name : '', candSkills: cand ? cand.skills : [],
      matchSnapshot: snap, matched_at: a.matched_at || '',
      stageSnapshot: stageSnap, entered_at: a.entered_at || '',
      match: latest,
      events: appEvents.filter(e => e.application_id === a.id),
      interviews: its, offer: of,
      offerLogs: offerLogs.filter(l => l.application_id === a.id)
    }
  })
  res.json({
    positions, candidates, applications: pipelines, interviews, offers, offerLogs, channels, matches,
    strategyVersions, strategyEvents, recalcJobs, recalcItems, users, approvals, notifications,
    defaultStrategy: { weights: { ...DEFAULT_WEIGHTS }, keywordCap: DEFAULT_KEYWORD_CAP },
    ...getCrisisState(),
    ...getScheduleState()
  })
})

app.get('/api/summary', (req, res) => {
  const pos = db.prepare('SELECT status, COUNT(*) c FROM positions GROUP BY status').all()
  const apps = db.prepare('SELECT stage, COUNT(*) c FROM applications GROUP BY stage').all()
  const cand = db.prepare('SELECT COUNT(*) c FROM candidates').get().c
  return res.json({ positions: pos, applications: apps, candidates: cand })
})

// ---------------- 职位 ----------------
app.post('/api/positions', (req, res) => {
  const b = req.body || {}
  const r = db.prepare('INSERT INTO positions(name,dept,city,level,salary_min,salary_max,skills,years,slots,status,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(b.name, b.dept || '技术部', b.city || '上海', b.level || 'P5', num(b.salary_min, 15000), num(b.salary_max, 30000), JSON.stringify(b.skills || []), num(b.years, 2), num(b.slots, 1), 'open', ts())
  res.json({ ok: true, id: Number(r.lastInsertRowid) })
})

app.post('/api/positions/:id', (req, res) => {
  const id = num(req.params.id)
  const b = req.body || {}
  if (b.status) db.prepare('UPDATE positions SET status=? WHERE id=?').run(b.status, id)
  if (b.skills !== undefined) db.prepare('UPDATE positions SET skills=? WHERE id=?').run(JSON.stringify(b.skills), id)
  res.json({ ok: true })
})

// ---------------- 按职位配置/发布匹配策略 ----------------
function serializeStrategyVersion(v) {
  if (!v) return null
  return {
    ...strategyPayload(getStrategyVersion(v.id) || v),
    approvalTaskId: num(v.approval_task_id),
    recalcOnActivate: !!num(v.recalc_on_activate),
    changeNote: v.change_note || ''
  }
}

function versionsForPosition(posId) {
  return db.prepare('SELECT * FROM strategy_versions WHERE position_id=? ORDER BY id DESC').all().map(serializeStrategyVersion)
}

// 读取某职位当前生效策略、灰度/稳定指针、窗口和版本历史（未配置返回系统默认）
app.get('/api/positions/:id/strategy', (req, res) => {
  const id = num(req.params.id)
  const pos = db.prepare('SELECT id,name,dept FROM positions WHERE id=?').get(id)
  if (!pos) return res.status(404).json({ ok: false })
  res.json({
    ok: true,
    position: pos,
    strategy: getStrategy(id),
    versions: versionsForPosition(id),
    defaults: { weights: { ...DEFAULT_WEIGHTS }, keywordCap: DEFAULT_KEYWORD_CAP }
  })
})

function insertStrategyVersion(id, { weights, keywordCap, status, activeAt, canaryEndAt, expireAt, canaryPercent, baseVersionId, actor, note, approvalTaskId = 0, recalc = true }) {
  const stamp = ts()
  const r = db.prepare(`INSERT INTO strategy_versions(position_id,weights,keyword_cap,published_at,published_by,status,active_at,canary_end_at,expire_at,canary_percent,is_stable,is_canary,base_version_id,approval_task_id,recalc_on_activate,change_note,created_at,updated_at)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, JSON.stringify(weights), keywordCap, stamp, actor, status, activeAt, canaryEndAt,
      expireAt, canaryPercent, status === 'active' ? 1 : 0, status === 'canary' ? 1 : 0,
      baseVersionId, approvalTaskId, recalc ? 1 : 0, note, stamp, stamp)
  return getStrategyVersion(Number(r.lastInsertRowid))
}

function notifyStrategy(recipientRole, type, title, body, taskId = 0, posId = 0, versionId = 0) {
  db.prepare(`INSERT INTO notifications(recipient_role,type,title,body,task_id,application_id,is_read,created_at)
              VALUES(?,?,?,?,?,0,0,?)`).run(recipientRole, type, title, body, taskId, ts())
}

// 配置并提交/直接发布策略：归一化权重 → 不可变版本 → 审批/定时/灰度/立即生效。
// body: { reset, weights, keyword_cap, active_at, canary_end_at, expire_at, canary_percent, approval, recalc, change_note }
app.post('/api/positions/:id/strategy', (req, res, next) => {
  const id = num(req.params.id)
  const pos = db.prepare('SELECT id,name,dept FROM positions WHERE id=?').get(id)
  if (!pos) return res.status(404).json({ ok: false })
  const user = currentUser(req)
  if (user.role !== 'recruiter') return res.status(403).json({ ok: false, code: 'role_not_allowed', msg: '匹配策略发布需由招聘负责人操作' })
  const b = req.body || {}
  try {
    let weights, keywordCap
    if (b.reset) {
      weights = { ...DEFAULT_WEIGHTS }
      keywordCap = DEFAULT_KEYWORD_CAP
    } else {
      weights = normalizeWeights(b.weights || {})
      keywordCap = Math.max(0, Math.min(20, num(b.keyword_cap, DEFAULT_KEYWORD_CAP)))
    }
    const canaryPercent = b.canary_percent === undefined ? 0 : Math.max(0, Math.min(100, Math.round(num(b.canary_percent))))
    const activeAt = parseWindowTime(b.active_at, true)
    const canaryEndAt = parseWindowTime(b.canary_end_at, false)
    const expireAt = parseWindowTime(b.expire_at, false)
    const isFuture = activeAt > now()
    const isCanary = canaryPercent > 0 && canaryPercent < 100
    if (canaryEndAt && isCanary && canaryEndAt <= activeAt) badRequest('灰度截止时间必须晚于生效开始时间', 'invalid_canary_window')
    if (expireAt && expireAt <= activeAt) badRequest('失效时间必须晚于生效开始时间', 'invalid_effective_window')

    const out = tx(() => {
      assertNoInFlightStrategy(id)
      const actor = b.published_by || user.name || 'HR'
      const note = String(b.change_note || '').slice(0, 300)
      const recalc = b.recalc !== false
      const current = db.prepare('SELECT current_version_id, stable_version_id, canary_version_id FROM match_strategies WHERE position_id=?').get(id)
      const baseVersionId = current?.stable_version_id || current?.current_version_id || 0

      // 新版本默认走审批；旧调用传 approval:false/direct:true 时保留“发布即生效”的历史兼容行为
      if (b.approvals === false || b.approval === false || b.direct === true) {
        const status = isFuture ? 'scheduled' : (isCanary ? 'canary' : 'active')
        const v = insertStrategyVersion(id, {
          weights, keywordCap, status, activeAt, canaryEndAt, expireAt,
          canaryPercent: isCanary ? canaryPercent : (canaryPercent >= 100 ? 100 : 0),
          baseVersionId, actor, note, recalc
        })
        let jobId = 0, pairs = 0
        if (!isFuture) {
          const r = isCanary
            ? (() => {
                const base = baseVersionId ? getStrategyVersion(baseVersionId) : null
                upsertStrategyPointer(id, {
                  currentId: baseVersionId, canaryId: v.id, stableId: baseVersionId,
                  weights: base ? base.weights : DEFAULT_WEIGHTS,
                  keywordCap: base?.keyword_cap ?? DEFAULT_KEYWORD_CAP,
                  publishedAt: base?.published_at || '', publishedBy: base?.published_by || '系统默认'
                })
                addStrategyEvent(v, 'canary_start', { actor, note, fromStatus: 'canary', toStatus: 'canary' })
                return recomputePositionWithChannels(id, { canaryVersion: v, stableVersion: base, triggerType: 'strategy_publish', triggeredBy: actor })
              })()
            : (() => {
                db.prepare("UPDATE strategy_versions SET status='retired', is_stable=0, is_canary=0, updated_at=? WHERE position_id=? AND status IN ('active','canary') AND id!=?", ts(), id, v.id).run()
                upsertStrategyPointer(id, { currentId: v.id, canaryId: 0, stableId: v.id, weights, keywordCap, publishedAt: v.published_at, publishedBy: actor })
                addStrategyEvent(v, 'activate', { actor, note, fromStatus: 'active', toStatus: 'active' })
                return recomputePositionWithChannels(id, { canaryVersion: null, stableVersion: v, triggerType: 'strategy_publish', triggeredBy: actor })
              })()
          jobId = r.jobId; pairs = r.pairs
        } else {
          addStrategyEvent(v, 'scheduled', { actor, note, fromStatus: 'scheduled', toStatus: 'scheduled', detail: { active_at: activeAt } })
        }
        return { ok: true, approval: false, versionId: v.id, status: v.status, jobId, pairs: pairs }
      }

      const v = insertStrategyVersion(id, {
        weights, keywordCap, status: 'pending_approval', activeAt, canaryEndAt, expireAt,
        canaryPercent: isCanary ? canaryPercent : (canaryPercent >= 100 ? 100 : 0),
        baseVersionId, actor, note, recalc
      })
      const payload = {
        position_id: id,
        strategy_version_id: v.id,
        weights,
        keyword_cap: keywordCap,
        active_at: activeAt,
        canary_end_at: canaryEndAt,
        expire_at: expireAt,
        canary_percent: canaryPercent,
        recalc,
        change_note: note,
        is_future: isFuture,
        is_canary: isCanary
      }
      const chain = buildChain('strategy_publish', payload, { position_id: id })
      const tr = db.prepare(`INSERT INTO approval_tasks(type,application_id,position_id,strategy_version_id,payload,chain,current_step,status,submitted_by,submitted_by_name,submitted_role,submitted_at,version)
                             VALUES('strategy_publish',0,?,?,?,? ,0,'pending',?,?,?,ts(),1)`)
        .run(id, v.id, JSON.stringify(payload), JSON.stringify(chain), user.id, user.name, user.role)
      const taskId = Number(tr.lastInsertRowid)
      db.prepare('UPDATE strategy_versions SET approval_task_id=?, updated_at=? WHERE id=?').run(taskId, ts(), v.id)
      addStep(taskId, { stepNo: -1, role: user.role, action: 'submit', actor: user, note: note || `策略 v${v.id} 提交发布审批` })
      addStrategyEvent({ ...v, approval_task_id: taskId }, 'submit', {
        actor: user.name, note, approvalTaskId: taskId, fromStatus: 'pending_approval', toStatus: 'pending_approval',
        detail: payload
      })
      notifyStrategy(chain[0].role, 'task_submitted', '新的匹配策略发布审批待处理',
        `${user.name} 提交「${pos.name}」策略 v${v.id}：${isCanary ? `${canaryPercent}% 灰度` : isFuture ? '定时生效' : '立即稳定发布'}${note ? ` · ${note}` : ''}`,
        taskId, id, v.id)
      return { ok: true, approval: true, taskId, versionId: v.id, status: 'pending_approval', chain }
    })
    res.json({
      ok: true,
      strategy: { weights, keywordCap, versionId: out.versionId, status: out.status, publishedAt: ts() },
      approval_task_id: out.taskId || 0,
      job_id: out.jobId || 0,
      recalced: out.pairs || 0
    })
  } catch (e) { next(e) }
})

// 版本治理操作：转正灰度 / 结束灰度恢复基线 / 取消待审批或待生效版本
app.post('/api/strategy-versions/:id/promote', (req, res, next) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') return res.status(403).json({ ok: false, code: 'role_not_allowed', msg: '策略灰度转正需由招聘负责人操作' })
  try {
    const r = tx(() => promoteCanaryVersion(num(req.params.id), { actor: req.body?.actor || user.name, note: req.body?.note || '' }))
    res.json({ ok: true, version_id: r.version.id, job_id: r.jobId, pairs: r.pairs })
  } catch (e) { next(e) }
})
app.post('/api/strategy-versions/:id/end-canary', (req, res, next) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') return res.status(403).json({ ok: false, code: 'role_not_allowed', msg: '结束灰度需由招聘负责人操作' })
  try {
    const r = tx(() => endCanaryVersion(num(req.params.id), { actor: req.body?.actor || user.name, note: req.body?.note || '' }))
    res.json({ ok: true, version_id: r.version.id, job_id: r.jobId, pairs: r.pairs })
  } catch (e) { next(e) }
})
// 回滚：可指定恢复到任意历史版本；不传 version_id 时恢复当前灰度基线/上一稳定版本（v0=默认）
app.post('/api/positions/:id/strategy/rollback', (req, res, next) => {
  const id = num(req.params.id)
  const user = currentUser(req)
  if (user.role !== 'recruiter') return res.status(403).json({ ok: false, code: 'role_not_allowed', msg: '策略回滚需由招聘负责人操作' })
  const b = req.body || {}
  if (!String(b.note || b.reason || '').trim()) return res.status(400).json({ ok: false, code: 'note_required', msg: '策略回滚必须填写原因' })
  try {
    const r = tx(() => createRollbackVersion(id, {
      actor: b.actor || user.name,
      note: b.note || b.reason,
      versionId: num(b.version_id)
    }))
    res.json({ ok: true, version_id: r.version.id, job_id: r.jobId, pairs: r.pairs })
  } catch (e) { next(e) }
})
app.post('/api/strategy-versions/:id/cancel', (req, res, next) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') return res.status(403).json({ ok: false, code: 'role_not_allowed', msg: '取消策略版本需由招聘负责人操作' })
  try {
    const out = tx(() => {
      const id = num(req.params.id)
      const v = versionRow(id, { allowStatuses: ['pending_approval', 'scheduled'] })
      if (v.approval_task_id && v.status === 'pending_approval') {
        const task = db.prepare('SELECT * FROM approval_tasks WHERE id=?').get(v.approval_task_id)
        if (task && task.status === 'pending') {
          db.prepare("UPDATE approval_tasks SET status='cancelled', decided_at=?, version=version+1 WHERE id=?").run(ts(), task.id)
          addStep(task.id, { stepNo: -1, role: task.submitted_role, action: 'cancel', actor: { id: task.submitted_by, name: req.body?.actor || user.name }, note: '策略版本取消，联动撤销审批' })
          notify({
            recipientRole: task.submitted_role, type: 'task_cancelled',
            title: '匹配策略发布审批已撤销',
            body: `职位 #${v.position_id} 策略 v${v.id} 已取消`, taskId: task.id, appId: 0
          })
        }
      }
      db.prepare("UPDATE strategy_versions SET status='cancelled', updated_at=? WHERE id=?").run(ts(), id)
      addStrategyEvent({ ...v, status: 'cancelled' }, 'cancel', {
        actor: req.body?.actor || user.name, note: req.body?.note || '',
        fromStatus: v.status, toStatus: 'cancelled', approvalTaskId: v.approval_task_id
      })
      if (v.status === 'scheduled' && v.base_version_id) {
        // 取消待生效版本不改变当前稳定指针
      }
      return { ok: true, version_id: id }
    })
    res.json(out)
  } catch (e) { next(e) }
})

// 手动执行生效窗口扫描：定时生效、灰度到期、稳定窗口失效均为幂等推进
app.post('/api/strategy/sweep', (req, res, next) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') return res.status(403).json({ ok: false, code: 'role_not_allowed', msg: '策略窗口扫描需由招聘负责人触发' })
  try {
    res.json(tx(() => runStrategySweep({ actor: user.name, manual: true })))
  } catch (e) { next(e) }
})

app.get('/api/strategy-governance', (req, res) => {
  const versions = db.prepare('SELECT * FROM strategy_versions ORDER BY id DESC').all()
  const events = db.prepare('SELECT * FROM strategy_version_events ORDER BY id DESC LIMIT 1000').all()
  const jobs = db.prepare("SELECT * FROM recalc_jobs WHERE trigger_type LIKE 'strategy_%' ORDER BY id DESC LIMIT 300").all()
  res.json({ ok: true, versions: versions.map(serializeStrategyVersion), events, jobs })
})

// ---------------- 批量重算推荐结果 ----------------
// 单职位：按当前稳定/灰度路由刷新全部候选人 × 该职位（含未投递候选人，保证推荐列表可用）
function recomputePosition(posId, jobId = 0) {
  const pos = db.prepare('SELECT id FROM positions WHERE id=?').get(posId)
  if (!pos) return 0
  const cands = db.prepare('SELECT id FROM candidates').all()
  if (!jobId) {
    const r = recomputePositionWithChannels(posId, { triggerType: 'manual', triggeredBy: 'HR' })
    return r.pairs
  }
  cands.forEach(c => upsertMatch(c.id, posId, jobId))
  return cands.length
}

app.post('/api/match/recompute', (req, res, next) => {
  const b = req.body || {}
  try {
    const result = tx(() => {
      let pairCount = 0, posCount = 0, targetPos = 0
      if (b.position_id) {
        const pos = db.prepare('SELECT id FROM positions WHERE id=?').get(num(b.position_id))
        if (!pos) return { notFound: true }
        const r = recomputePositionWithChannels(pos.id, { triggerType: 'manual', triggeredBy: b.triggered_by || 'HR' })
        return { ok: true, jobId: r.jobId, positions: 1, pairs: r.pairs, processed: r.processed || r.pairs }
      }

      // 全局：所有在招职位 × 全部候选人；同时补上已关闭职位上已存在的匹配对。
      // 每个职位使用自己的独立批次，避免一个全局批次混杂多个策略版本/灰度比例。
      const jobIds = []
      const posIds = db.prepare("SELECT id FROM positions WHERE status='open'").all().map(p => p.id)
      db.prepare("SELECT DISTINCT m.position_id FROM matches m JOIN positions p ON p.id=m.position_id WHERE p.status!='open'")
        .all().forEach(r => posIds.push(r.position_id))
      posIds.forEach(pid => {
        const r = recomputePositionWithChannels(pid, { triggerType: 'manual', triggeredBy: b.triggered_by || 'HR' })
        jobIds.push(r.jobId); pairCount += r.processed || r.pairs; posCount++
      })
      return { ok: true, jobId: jobIds[0] || 0, jobIds, positions: posCount, pairs: pairCount }
    })
    if (result.notFound) return res.status(404).json({ ok: false })
    res.json({ ok: true, positions: result.positions, pairs: result.pairs, job_id: result.jobId, job_ids: result.jobIds || [], recomputed_at: ts() })
  } catch (e) { next(e) }
})

// ---------------- 候选人 ----------------
app.post('/api/candidates', (req, res) => {
  const b = req.body || {}
  const r = db.prepare('INSERT INTO candidates(name,phone,skills,years,edu,school,city,exp_salary,channel,raw) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(b.name, b.phone || '', JSON.stringify(b.skills || []), num(b.years, 0), b.edu || '本科', b.school || '', b.city || '', num(b.exp_salary, 0), b.channel || '内推', b.raw || `候选人${b.name}的简历`)
  res.json({ ok: true, id: Number(r.lastInsertRowid) })
})

app.delete('/api/candidates/:id', (req, res) => {
  db.prepare('DELETE FROM candidates WHERE id=?').run(num(req.params.id))
  res.json({ ok: true })
})

// ---------------- 匹配 ----------------
app.get('/api/match/pos/:pid', (req, res) => {
  const posId = num(req.params.pid)
  const pos = db.prepare('SELECT * FROM positions WHERE id=?').get(posId)
  if (!pos) return res.status(404).json({ ok: false })
  const cands = db.prepare('SELECT * FROM candidates').all()
  const rows = cands.map(c => {
    // 浏览推荐时实时计算；只有显式“批量重算/发布策略”才更新最新结果与审计批次
    const m = computePair(c.id, posId)
    return { candidate_id: c.id, name: c.name, skills: parseSkills(c.skills), years: c.years, edu: c.edu, city: c.city, exp_salary: c.exp_salary, score: m.score, dims: m.dims, reason: m.reason, weakness: m.weakness, computed_at: m.computed_at, strategy_id: m.strategy_id, strategy_mode: m.strategy_mode, canary_percent: m.canary_percent, canary_bucket: m.canary_bucket, in_canary: m.in_canary, active_at: m.active_at, expire_at: m.expire_at }
  })
  rows.sort((a, b) => b.score - a.score)
  const strategy = getStrategy(posId)
  res.json({ position: { ...pos, skills: parseSkills(pos.skills) }, candidates: rows, strategy })
})

app.get('/api/match/cand/:cid', (req, res) => {
  const candId = num(req.params.cid)
  const cand = db.prepare('SELECT * FROM candidates WHERE id=?').get(candId)
  if (!cand) return res.status(404).json({ ok: false })
  const poss = db.prepare("SELECT * FROM positions WHERE status='open'").all()
  const rows = poss.map(p => {
    // 与按职位推荐共用同一实时计算逻辑；显式重算的结果才写入最新结果/批次明细
    const m = computePair(candId, p.id)
    return { position_id: p.id, name: p.name, dept: p.dept, city: p.city, level: p.level, salary_min: p.salary_min, salary_max: p.salary_max, score: m.score, dims: m.dims, reason: m.reason, weakness: m.weakness, computed_at: m.computed_at, strategy_id: m.strategy_id, strategy_is_default: m.strategy_is_default, strategy_mode: m.strategy_mode, canary_percent: m.canary_percent, canary_bucket: m.canary_bucket, in_canary: m.in_canary, active_at: m.active_at, expire_at: m.expire_at }
  })
  rows.sort((a, b) => b.score - a.score)
  res.json({ candidate: { name: cand.name, skills: parseSkills(cand.skills), years: cand.years }, positions: rows })
})

// ---------------- 应聘流程 ----------------
function getStoredMatch(candId, posId) {
  return db.prepare('SELECT * FROM matches WHERE candidate_id=? AND position_id=?').get(candId, posId) || null
}

function resultFromStored(row) {
  if (!row) return null
  const v = getStrategyVersion(row.strategy_id)
  return {
    score: num(row.score),
    dims: parseDims(row.dims, '[]'),
    reason: row.reason,
    weakness: row.weakness,
    computed_at: row.computed_at,
    strategy_id: num(row.strategy_id),
    strategy_mode: row.strategy_mode || (num(row.strategy_id) ? 'stable' : 'default'),
    canary_percent: num(row.canary_percent),
    weights: v ? v.weights : { ...DEFAULT_WEIGHTS },
    keyword_cap: v ? v.keyword_cap : DEFAULT_KEYWORD_CAP,
    strategy_is_default: !v,
    active_at: v?.active_at || '',
    expire_at: v?.expire_at || ''
  }
}

function latestJobForPair(candId, posId) {
  return db.prepare(`SELECT ri.job_id, ri.strategy_id, ri.computed_at
                     FROM recalc_items ri
                     WHERE ri.candidate_id=? AND ri.position_id=?
                     ORDER BY ri.id DESC LIMIT 1`).get(candId, posId) || null
}

// 写入/刷新「进入某阶段」的正式事件（backfilled=0）：
// 同一 application×stage 永远只有一条正式事件（部分唯一索引兜底），候选人再次进入该阶段时
// 直接刷新该行，保证阶段快照、时间线与当前阶段口径一致；补录事件不受影响
function insertStageEvent({ applicationId, stage, fromStage, eventType = 'advance', operator = 'HR-Sandy', candId, posId, latest, backfilled = false }) {
  const source = latest || resultFromStored(getStoredMatch(candId, posId))
  const item = latestJobForPair(candId, posId)
  const linkedItem = source && item && item.computed_at === source.computed_at ? item : null
  const recalcJobId = latest && Object.prototype.hasOwnProperty.call(latest, 'recalc_job_id')
    ? num(latest.recalc_job_id)
    : num(linkedItem?.job_id || 0)
  const stamp = ts()
  const snap = buildSnapshot(candId, posId, source || {
    score: 0, dims: [], reason: '暂无已发布评分', weakness: '暂无评分依据'
  }, {
    stage,
    stage_label: STAGE_LABEL[stage] || stage,
    event_type: eventType,
    event_at: stamp,
    recalc_job_id: recalcJobId,
    backfilled
  })
  if (backfilled) {
    db.prepare(`INSERT INTO application_events(application_id,stage,from_stage,event_type,event_at,operator,score_snapshot,match_score,strategy_id,strategy_mode,canary_percent,recalc_job_id,backfilled)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)
                ON CONFLICT(application_id,stage) WHERE backfilled=0 DO NOTHING`)
      .run(applicationId, stage, fromStage || '', eventType, stamp, operator,
        JSON.stringify(snap), snap.score, snap.strategy_id, snap.strategy_mode, snap.canary_percent, snap.recalc_job_id)
  } else {
    db.prepare(`INSERT INTO application_events(application_id,stage,from_stage,event_type,event_at,operator,score_snapshot,match_score,strategy_id,strategy_mode,canary_percent,recalc_job_id,backfilled)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)
                ON CONFLICT(application_id,stage) WHERE backfilled=0 DO UPDATE SET
                  from_stage=excluded.from_stage,event_type=excluded.event_type,event_at=excluded.event_at,
                  operator=excluded.operator,score_snapshot=excluded.score_snapshot,match_score=excluded.match_score,
                  strategy_id=excluded.strategy_id,strategy_mode=excluded.strategy_mode,canary_percent=excluded.canary_percent,recalc_job_id=excluded.recalc_job_id`)
      .run(applicationId, stage, fromStage || '', eventType, stamp, operator,
        JSON.stringify(snap), snap.score, snap.strategy_id, snap.strategy_mode, snap.canary_percent, snap.recalc_job_id)
  }
  return snap
}

// 阶段协同的唯一入口：更新应用阶段 + 乐观锁版本 + 阶段快照 + 阶段事件，保证四处口径一次事务内一致
function moveStage(app, stage, { eventType, fromStage, operator }) {
  const stamp = ts()
  db.prepare('UPDATE applications SET stage=?, updated=?, entered_at=?, stage_snapshot=?, version=version+1 WHERE id=?')
    .run(stage, stamp, stamp, '', app.id)
  const snap = insertStageEvent({
    applicationId: app.id, stage, fromStage: fromStage ?? app.stage, eventType,
    operator: operator || app.recruiter || 'HR-Sandy', candId: app.candidate_id, posId: app.position_id
  })
  // 事件刚写入，stage_snapshot 与其同源：直接固化为该阶段事件的评分快照和策略通道
  db.prepare('UPDATE applications SET stage_snapshot=?, strategy_mode=?, strategy_version_id=?, canary_percent=? WHERE id=?')
    .run(JSON.stringify(snap), snap.strategy_mode, snap.strategy_id, snap.canary_percent, app.id)
  app.stage = stage
  app.version = num(app.version) + 1
  return { stage, snapshot: snap }
}

// 异常回退到上一阶段的协同：终态先解除（Offer 重置为已撤回），再写 rollback 事件与新的阶段快照
function rollbackStage(app, { operator, expectedVersion, reason = '' }) {
  checkVersion(app, expectedVersion)
  if (app.stage === 'rejected') {
    const target = PREV_STAGE[app.reject_from || ''] || ''
    if (!target) badRequest('该淘汰记录缺少回退来源，请先在追溯中确认来源阶段', 'rollback_no_source')
    return reopenRejected(app, { target, operator, reason })
  }
  const target = PREV_STAGE[app.stage]
  if (!target) badRequest('投递阶段无法继续回退', 'rollback_first_stage')
  // 从 Offer 阶段回退：进行中/已接受的 Offer 必须撤回，避免 Offer 页与流程页口径不一致
  if (app.stage === 'offer') withdrawActiveOffer(app, { operator, reason })
  if (app.stage === 'hired') withdrawAcceptedOffer(app, { operator, reason })
  return moveStage(app, target, { eventType: 'rollback', operator, fromStage: app.stage })
}

function reopenRejected(app, { target, operator, reason = '' }) {
  const of = offerOfApp(app.id)
  if (of && (of.status === 'accepted' || of.status === 'joined')) {
    badRequest('候选人已接受 Offer/已入职，不能从淘汰复活', 'terminal_locked')
  }
  if (of && of.status === 'pending') withdrawActiveOffer(app, { operator, reason, force: true })
  return moveStage(app, target, { eventType: 'rollback', operator, fromStage: 'rejected' })
}

function withdrawActiveOffer(app, { operator, reason = '', force = false }) {
  const of = offerOfApp(app.id)
  if (!of || (of.status !== 'pending' && !force)) return null
  const stamp = ts()
  db.prepare('UPDATE offers SET status=?, note=?, decided_at=?, decided_by=? WHERE id=?')
    .run('withdrawn', reason || of.note, stamp, operator || 'HR-Sandy', of.id)
  addOfferLog({
    offerId: of.id, applicationId: app.id, changeType: 'withdraw', of,
    toStatus: 'withdrawn', operator: operator || 'HR-Sandy', note: reason
  })
  of.status = 'withdrawn'
  return of
}

function withdrawAcceptedOffer(app, { operator, reason }) {
  const of = offerOfApp(app.id)
  if (!of || (of.status !== 'accepted' && of.status !== 'joined')) return null
  const stamp = ts()
  db.prepare('UPDATE offers SET status=?, note=?, decided_at=?, decided_by=?, joined_at=? WHERE id=?')
    .run('withdrawn', reason || of.note, stamp, operator || 'HR-Sandy', app.stage === 'hired' ? '' : of.joined_at, of.id)
  addOfferLog({
    offerId: of.id, applicationId: app.id, changeType: 'withdraw', of,
    toStatus: 'withdrawn', operator: operator || 'HR-Sandy', note: reason
  })
  of.status = 'withdrawn'
  return of
}

app.post('/api/applications', (req, res) => {
  const b = req.body || {}
  const pid = num(b.position_id), cid = num(b.candidate_id)
  const dup = db.prepare('SELECT id FROM applications WHERE position_id=? AND candidate_id=?').get(pid, cid)
  if (dup) return res.status(409).json({ ok: false, code: 'duplicate_application', msg: '该候选人已投递此职位，请勿重复投递' })
  const cand = db.prepare('SELECT * FROM candidates WHERE id=?').get(cid)
  const pos = db.prepare('SELECT * FROM positions WHERE id=?').get(pid)
  if (!cand || !pos) return res.status(404).json({ ok: false, msg: '职位或候选人不存在' })
  const out = tx(() => {
    // 投递时同步固化当前评分证据；不创建重算批次，避免把单个投递伪装成批量策略重算
    const m = upsertMatch(cid, pid, 0)
    const stamp = now()
    const snap = buildSnapshot(cid, pid, { ...m, computed_at: stamp }, {
      stage: 'submitted',
      stage_label: '投递',
      event_type: 'advance',
      matched_at: stamp,
      recalc_job_id: 0
    })
    const r = db.prepare(`INSERT INTO applications(position_id,candidate_id,stage,updated,recruiter,match_snapshot,matched_at,stage_snapshot,entered_at,strategy_mode,strategy_version_id,canary_percent,version)
                          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)`)
      .run(pid, cid, 'submitted', ts(), b.recruiter || 'HR-Sandy', JSON.stringify(snap), snap.matched_at,
        JSON.stringify(snap), ts(), snap.strategy_mode, snap.strategy_id, snap.canary_percent)
    const appId = Number(r.lastInsertRowid)
    insertStageEvent({
      applicationId: appId, stage: 'submitted', fromStage: '', eventType: 'advance',
      operator: b.recruiter || 'HR-Sandy', candId: cid, posId: pid, latest: m
    })
    return { id: appId }
  })
  res.json({ ok: true, id: out.id })
})

// 阶段推进核心：只能沿投递→筛选→面试→Offer→录用顺序前进，且受面试结论/Offer 状态约束。
// 供「直接推进端点」与「审批通过后的执行回写」共用；targetStage 用于审批场景校验申请时锁定的目标阶段未漂移
function advanceApplication(a, { operator, expectedVersion, targetStage } = {}) {
  checkVersion(a, expectedVersion)
  if (a.stage === 'rejected') conflict('候选人已淘汰，请先「异常回退」复活后再推进', 'rejected_locked')
  const next = NEXT_STAGE[a.stage]
  if (!next) conflict('已到最后阶段，无需重复推进', 'last_stage')
  if (targetStage && next !== targetStage) {
    conflict(`流程阶段已变化（当前「${STAGE_LABEL[a.stage]}」），无法按申请推进到「${STAGE_LABEL[targetStage] || targetStage}」`, 'stage_mismatch')
  }
  if (next === 'offer') assertCanEnterOffer(a)
  // Offer → 录用只能由「接受 Offer」驱动，防止跳过候选人接受确认
  if (next === 'hired') {
    const of = offerOfApp(a.id)
    if (!of || of.status !== 'accepted') badRequest('请先在 Offer 管理中等待候选人接受 Offer', 'offer_not_accepted')
  }
  const r = moveStage(a, next, { eventType: 'advance', operator })
  return { stage: next, version: a.version, snapshot: r.snapshot }
}

app.post('/api/applications/:id/advance', (req, res, next) => {
  const id = num(req.params.id)
  const b = req.body || {}
  try {
    const out = tx(() => {
      const a = db.prepare('SELECT * FROM applications WHERE id=?').get(id)
      if (!a) return { notFound: true }
      const r = advanceApplication(a, { operator: b.operator, expectedVersion: b.version })
      return { ok: true, ...r }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

app.post('/api/applications/:id/reject', (req, res, next) => {
  const id = num(req.params.id)
  const b = req.body || {}
  const actor = currentUser(req)
  try {
    const out = tx(() => {
      const a = db.prepare('SELECT * FROM applications WHERE id=?').get(id)
      if (!a) return { notFound: true }
      checkVersion(a, b.version)
      if (a.stage === 'rejected') conflict('该候选人已淘汰，请勿重复操作', 'already_rejected')
      if (a.stage === 'hired') conflict('候选人已录用，不能淘汰；如需修正请走异常回退', 'hired_locked')
      // 待回应 Offer 随淘汰一并撤回，Offer 记录与流程阶段保持同一口径
      withdrawActiveOffer(a, { operator: b.operator, reason: b.reason || '候选人流程淘汰', force: true })
      const fromStage = a.stage
      const r = moveStage(a, 'rejected', {
        eventType: fromStage === 'offer' ? 'offer_rejected' : 'reject',
        operator: b.operator, fromStage
      })
      db.prepare('UPDATE applications SET reject_from=? WHERE id=?').run(fromStage, id)
      auditPassive({
        category: 'action', action: 'state.reject', actor, applicationId: id,
        refType: 'application', refId: id,
        summary: `危机相关流程淘汰：${STAGE_LABEL[fromStage] || fromStage} → 淘汰`,
        detail: { from: fromStage, to: 'rejected', reason: b.reason || '' }
      })
      return { ok: true, stage: 'rejected', from: fromStage, version: a.version, snapshot: r.snapshot }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// 异常回退：仅允许回到上一阶段（淘汰复活除外），写 rollback 事件并刷新阶段快照，全程留痕
app.post('/api/applications/:id/rollback', (req, res, next) => {
  const id = num(req.params.id)
  const b = req.body || {}
  const actor = currentUser(req)
  try {
    const out = tx(() => {
      const a = db.prepare('SELECT * FROM applications WHERE id=?').get(id)
      if (!a) return { notFound: true }
      const fromStage = a.stage
      const offerBefore = offerOfApp(a.id)
      const r = rollbackStage(a, { operator: b.operator, expectedVersion: b.version, reason: b.reason || '' })
      if (a.stage === 'rejected') db.prepare("UPDATE applications SET reject_from='' WHERE id=?").run(id)
      const offerAfter = offerOfApp(a.id)
      // 若该应聘关联了进行中的危机事件，状态回退同事务追加到不可篡改审计链
      auditPassive({
        category: 'rollback', action: 'state.rollback', actor, applicationId: id,
        refType: 'application', refId: id,
        summary: `流程异常回退：${STAGE_LABEL[fromStage] || fromStage} → ${STAGE_LABEL[a.stage] || a.stage}`,
        detail: {
          from: fromStage, to: a.stage, reason: b.reason || '',
          offer_withdrawn: !!offerBefore && offerBefore.status !== 'withdrawn' && offerAfter?.status === 'withdrawn'
        }
      })
      return { ok: true, stage: a.stage, version: a.version, snapshot: r.snapshot }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// ---------------- 面试 ----------------
app.post('/api/applications/:id/interview', (req, res, next) => {
  const b = req.body || {}
  try {
    const out = tx(() => {
      const appId = num(req.params.id)
      const a = db.prepare('SELECT id,stage FROM applications WHERE id=?').get(appId)
      if (!a) return { notFound: true }
      if (a.stage === 'rejected' || a.stage === 'hired') conflict('该候选人流程已终态，不能再安排面试', 'terminal_locked')
      const r = db.prepare('INSERT INTO interviews(application_id,interviewer,time,round,eval,result,conclusion) VALUES(?,?,?,?,?,?,\'pending\')')
        .run(appId, b.interviewer || '面试官', b.time || ts(), b.round || '初试', b.eval || '', b.result === 'pass' || b.result === 'fail' ? b.result : 'pending')
      return { ok: true, id: Number(r.lastInsertRowid) }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// 面试结论协同核心：双写 conclusion/result 并记录决定人；最近一轮「不通过」自动淘汰，
// 淘汰态改判「通过/待定」复活回面试阶段；录用后锁定，同结论幂等。
// 供「面试更新端点」与「面试结论审批通过后的执行回写」共用
function applyInterviewConclusion(iv, a, conclusion, { operator } = {}) {
  const current = iv.conclusion || iv.result || 'pending'
  if (a.stage === 'hired' && conclusion !== current) {
    conflict('候选人已录用，面试结论已锁定', 'terminal_locked')
  }
  if (conclusion === current) return { idempotent: true, version: num(a.version) }
  const stamp = ts()
  db.prepare('UPDATE interviews SET conclusion=?, result=?, decided_at=?, decided_by=? WHERE id=?')
    .run(conclusion, conclusion, stamp, operator || a.recruiter || 'HR-Sandy', iv.id)
  // 最近一轮给出「不通过」结论：应聘自动淘汰并固化阶段事件（仅对最近一轮生效，历史轮次改判不联动）
  const last = latestInterviewOf(a.id)
  if (conclusion === 'fail' && last && last.id === iv.id && a.stage !== 'rejected') {
    const fromStage = a.stage
    moveStage(a, 'rejected', { eventType: 'reject', operator, fromStage })
    db.prepare('UPDATE applications SET reject_from=? WHERE id=?').run(fromStage, a.id)
  }
  // 淘汰状态下「改判通过/待定」可复活：回到面试阶段（单步回退，避免跨阶段跳变）
  if (conclusion !== 'fail' && a.stage === 'rejected') {
    const target = a.reject_from && STAGES.includes(a.reject_from) && STAGES.indexOf(a.reject_from) <= STAGES.indexOf('interview')
      ? a.reject_from : 'interview'
    moveStage(a, target, { eventType: 'rollback', operator, fromStage: 'rejected' })
    db.prepare("UPDATE applications SET reject_from='' WHERE id=?").run(a.id)
  }
  return { idempotent: false, version: a.version }
}

// 更新面试评价/结论。结论(pass/fail/pending)与 result 双写兼容；同一结论重复提交直接幂等返回
app.post('/api/interviews/:id', (req, res, next) => {
  const b = req.body || {}
  const ivId = num(req.params.id)
  try {
    const out = tx(() => {
      const iv = db.prepare('SELECT * FROM interviews WHERE id=?').get(ivId)
      if (!iv) return { notFound: true }
      const a = db.prepare('SELECT * FROM applications WHERE id=?').get(iv.application_id)
      if (!a) return { appNotFound: true }
      const sets = [], vals = []
      if (b.eval !== undefined) { sets.push('eval=?'); vals.push(String(b.eval)) }
      if (b.interviewer !== undefined) { sets.push('interviewer=?'); vals.push(String(b.interviewer)) }
      if (b.time !== undefined) { sets.push('time=?'); vals.push(String(b.time)) }
      if (sets.length) {
        vals.push(ivId)
        db.prepare(`UPDATE interviews SET ${sets.join(',')} WHERE id=?`).run(...vals)
      }

      const conclusion = ['pass', 'fail', 'pending'].includes(b.conclusion)
        ? b.conclusion
        : (['pass', 'fail', 'pending'].includes(b.result) ? b.result : null)
      if (conclusion) {
        const r = applyInterviewConclusion(iv, a, conclusion, { operator: b.operator })
        return { ok: true, ...r, conclusion }
      }
      return { ok: true, idempotent: false, conclusion: iv.conclusion || iv.result, version: num(a.version) }
    })
    if (out.notFound || out.appNotFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// ---------------- Offer ----------------
const SALARY_MIN = 1000, SALARY_MAX = 1000000

// 发起 Offer 核心：必须处于 Offer 阶段（非终态，面试阶段发起会协同推进）；同一应聘同时只能有一个
// 进行中的 Offer；被撤回/拒绝的旧记录原地重新发起并留痕。供「发起端点」与「Offer 审批通过后的执行回写」共用
function issueOffer(a, { salary, due, note, operator, expectedVersion } = {}) {
  checkVersion(a, expectedVersion)
  if (a.stage === 'rejected' || a.stage === 'hired') conflict('该候选人流程已终态，不能发起 Offer', 'terminal_locked')
  // 发起 Offer 前同样受面试结论约束
  if (STAGES.indexOf(a.stage) < STAGES.indexOf('offer')) assertCanEnterOffer(a)
  const exist = offerOfApp(a.id)
  if (exist && exist.status === 'pending') conflict('该候选人已有待回应的 Offer，请勿重复发起', 'offer_duplicate')
  if (exist && (exist.status === 'accepted' || exist.status === 'joined')) {
    conflict('该候选人的 Offer 已被接受，不能重新发起', 'offer_accepted_locked')
  }
  salary = num(salary, 20000)
  if (salary < SALARY_MIN || salary > SALARY_MAX) badRequest(`Offer 月薪需在 ${SALARY_MIN}~${SALARY_MAX} 之间`, 'salary_range')
  const stamp = ts()
  operator = operator || a.recruiter || 'HR-Sandy'
  // 候选人还停留在面试阶段：发起即协同推进到 Offer（同事务写阶段事件+快照）
  if (STAGES.indexOf(a.stage) < STAGES.indexOf('offer')) {
    moveStage(a, 'offer', { eventType: 'advance', operator, fromStage: a.stage })
  }
  let offerId
  if (exist) {
    // 复用被撤回/拒绝的旧记录：重新发起，保留薪资历史可追溯
    db.prepare('UPDATE offers SET salary=?, status=?, due=?, note=?, decided_at=?, decided_by=?, joined_at=? WHERE id=?')
      .run(salary, 'pending', due || stamp, note || '', '', '', '', exist.id)
    offerId = exist.id
    addOfferLog({ offerId, applicationId: a.id, changeType: 'reopen', of: exist, toStatus: 'pending', toSalary: salary, operator, note: note || '' })
  } else {
    const r = db.prepare('INSERT INTO offers(application_id,salary,status,due,note) VALUES(?,?,?,?,?)')
      .run(a.id, salary, 'pending', due || stamp, note || '')
    offerId = Number(r.lastInsertRowid)
    addOfferLog({
      offerId, applicationId: a.id, changeType: 'create',
      of: { status: '', salary: 0 }, toStatus: 'pending', toSalary: salary, operator, note: note || ''
    })
  }
  return { id: offerId, stage: a.stage, version: a.version }
}

app.post('/api/applications/:id/offer', (req, res, next) => {
  const b = req.body || {}
  const appId = num(req.params.id)
  try {
    const out = tx(() => {
      const a = db.prepare('SELECT * FROM applications WHERE id=?').get(appId)
      if (!a) return { notFound: true }
      const r = issueOffer(a, { salary: b.salary, due: b.due, note: b.note, operator: b.operator, expectedVersion: b.version })
      return { ok: true, ...r }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// Offer 变更统一入口：
//  - 字段更新 salary/due/note 仅允许 pending（避免接受后暗改薪酬）
//  - status 仅允许 pending→accepted/rejected/withdrawn、accepted→joined（终态/跳跃变更拒绝）
//  - 每次变更追加 offer_change_logs；接受/拒绝/入职与应用阶段、阶段事件同事务提交
app.post('/api/offers/:id', (req, res, next) => {
  const b = req.body || {}
  const offerId = num(req.params.id)
  try {
    const out = tx(() => {
      const of = db.prepare('SELECT * FROM offers WHERE id=?').get(offerId)
      if (!of) return { notFound: true }
      const a = db.prepare('SELECT * FROM applications WHERE id=?').get(of.application_id)
      if (!a) return { appNotFound: true }
      checkVersion(a, b.version)
      const operator = b.operator || a.recruiter || 'HR-Sandy'
      const stamp = ts()

      // ---- 字段变更（仅待回应可改，且写留痕）----
      if (b.salary !== undefined) {
        if (of.status !== 'pending') conflict('仅待回应的 Offer 可以调整薪资', 'offer_locked')
        const salary = num(b.salary, of.salary)
        if (salary < SALARY_MIN || salary > SALARY_MAX) badRequest(`Offer 月薪需在 ${SALARY_MIN}~${SALARY_MAX} 之间`, 'salary_range')
        if (salary !== num(of.salary)) {
          db.prepare('UPDATE offers SET salary=? WHERE id=?').run(salary, offerId)
          addOfferLog({ offerId, applicationId: a.id, changeType: 'update_salary', of, toStatus: of.status, toSalary: salary, operator, note: b.note || '' })
          of.salary = salary
        }
      }
      if (b.due !== undefined && String(b.due) !== String(of.due)) {
        if (of.status !== 'pending') conflict('仅待回应的 Offer 可以调整期限', 'offer_locked')
        db.prepare('UPDATE offers SET due=? WHERE id=?').run(String(b.due), offerId)
        addOfferLog({ offerId, applicationId: a.id, changeType: 'update_due', of, toStatus: of.status, toSalary: of.salary, operator })
      }
      if (b.note !== undefined && String(b.note) !== String(of.note)) {
        db.prepare('UPDATE offers SET note=? WHERE id=?').run(String(b.note), offerId)
      }

      // ---- 状态流转 ----
      let moved = null
      if (b.status && b.status !== of.status) {
        const s = b.status
        const allowed = {
          pending: ['accepted', 'rejected', 'withdrawn'],
          accepted: ['joined', 'withdrawn'],
          rejected: [], withdrawn: [], joined: []
        }[of.status] || []
        if (of.status === s) return { ok: true, idempotent: true, stage: a.stage, version: num(a.version) }
        if (!allowed.includes(s)) conflict(`Offer 不能从「${of.status}」变更为「${s}」，请按待回应→接受/拒绝→入职流转`, 'offer_transition')

        if (s === 'accepted') {
          db.prepare('UPDATE offers SET status=?, decided_at=?, decided_by=? WHERE id=?').run('accepted', stamp, operator, offerId)
          addOfferLog({ offerId, applicationId: a.id, changeType: 'accept', of, toStatus: 'accepted', operator, note: b.note || '' })
          if (a.stage !== 'hired' && a.stage !== 'rejected') {
            // 接受 Offer 即进入「录用」阶段，固化当时评分证据
            moved = moveStage(a, 'hired', { eventType: 'offer_accepted', operator, fromStage: a.stage })
          }
        } else if (s === 'joined') {
          db.prepare('UPDATE offers SET status=?, joined_at=COALESCE(NULLIF(joined_at,\'\'),?), decided_at=? WHERE id=?')
            .run('joined', stamp, stamp, offerId)
          addOfferLog({ offerId, applicationId: a.id, changeType: 'join', of: { ...of, status: 'accepted' }, toStatus: 'joined', operator, note: b.note || '' })
          if (a.stage !== 'hired') moved = moveStage(a, 'hired', { eventType: 'offer_accepted', operator, fromStage: a.stage })
        } else if (s === 'rejected') {
          db.prepare('UPDATE offers SET status=?, decided_at=?, decided_by=? WHERE id=?').run('rejected', stamp, operator, offerId)
          addOfferLog({ offerId, applicationId: a.id, changeType: 'reject', of, toStatus: 'rejected', operator, note: b.note || '' })
          if (a.stage !== 'rejected') {
            const fromStage = a.stage
            moved = moveStage(a, 'rejected', { eventType: 'offer_rejected', operator, fromStage })
            db.prepare('UPDATE applications SET reject_from=? WHERE id=?').run(fromStage, a.id)
          }
        } else if (s === 'withdrawn') {
          db.prepare('UPDATE offers SET status=?, decided_at=?, decided_by=?, note=? WHERE id=?')
            .run('withdrawn', stamp, operator, b.note || of.note, offerId)
          addOfferLog({ offerId, applicationId: a.id, changeType: 'withdraw', of, toStatus: 'withdrawn', operator, note: b.note || '' })
          // 已接受/已入职后撤回：录用阶段同步回退到 Offer（单步回退，事件留痕）
          if (a.stage === 'hired') moved = moveStage(a, 'offer', { eventType: 'rollback', operator, fromStage: 'hired' })
        }
      }
      return { ok: true, status: b.status || of.status, stage: a.stage, version: num(a.version), moved: !!moved }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    if (out.appNotFound) return res.status(409).json({ ok: false, code: 'app_missing', msg: 'Offer 对应的应聘记录不存在' })
    res.json(out)
  } catch (e) { next(e) }
})

// ---------------- 审批中心 ----------------
// 审批通过后的执行回写：按任务类型调用与直接操作完全相同的业务函数，
// 保证「审批生效」与「直接操作」走同一条状态机路径，阶段/面试/Offer 三处口径一致
function executeApprovalTask(task, actor) {
  const payload = parseJSON(task.payload, {})
  if (task.type === 'strategy_publish') {
    const activated = approveStrategyVersion(task, actor)
    const v = activated.version
    return {
      desc: v.status === 'scheduled'
        ? `策略 v${v.id} 已审批通过，等待 ${v.active_at.replace('T', ' ').slice(0, 16)} 生效`
        : v.status === 'canary'
          ? `策略 v${v.id} 已启动 ${v.canary_percent}% 灰度（批次 #${activated.jobId}）`
          : `策略 v${v.id} 已全量生效（批次 #${activated.jobId}）`,
      version: 0
    }
  }
  const a = db.prepare('SELECT * FROM applications WHERE id=?').get(task.application_id)
  if (!a) badRequest('关联应聘记录不存在', 'app_missing')
  if (task.type === 'stage_advance') {
    const r = advanceApplication(a, { operator: actor.name, targetStage: payload.target_stage })
    return { desc: `已推进至「${STAGE_LABEL[r.stage]}」阶段`, version: r.version }
  }
  if (task.type === 'interview_conclusion') {
    const iv = db.prepare('SELECT * FROM interviews WHERE id=?').get(num(payload.interview_id))
    if (!iv || iv.application_id !== a.id) badRequest('关联面试记录不存在', 'interview_missing')
    applyInterviewConclusion(iv, a, payload.conclusion, { operator: actor.name })
    return { desc: `「${iv.round}」面试结论已生效：${payload.conclusion === 'pass' ? '通过' : '不通过'}`, version: a.version }
  }
  if (task.type === 'offer_issue') {
    issueOffer(a, { salary: payload.salary, due: payload.due, note: payload.note, operator: actor.name })
    return { desc: `Offer 已发放（月薪 ¥${num(payload.salary).toLocaleString()}，待候选人回应）`, version: a.version }
  }
  badRequest('未知审批类型', 'unknown_task_type')
}

// 提交审批申请：校验发起角色权限 + 业务前置，固化审批链后通知第一级审批人
app.post('/api/approvals', (req, res, next) => {
  const user = currentUser(req)
  const b = req.body || {}
  const type = String(b.type || '')
  const meta = TASK_TYPES[type]
  try {
    const out = tx(() => {
      if (!meta) badRequest('未知审批类型', 'unknown_task_type')
      if (user.role !== meta.submitRole) {
        forbidden(`「${meta.label}」申请需由${ROLE_LABEL[meta.submitRole]}发起，当前身份为「${ROLE_LABEL[user.role]}」`, 'role_not_allowed')
      }
      const isStrategy = type === 'strategy_publish'
      const a = isStrategy ? null : db.prepare('SELECT * FROM applications WHERE id=?').get(num(b.application_id))
      if (!isStrategy && !a) return { notFound: true }
      // 同一业务对象同一类型只允许一个进行中的审批，防止重复申请/并发发布
      const dup = isStrategy
        ? db.prepare("SELECT id FROM approval_tasks WHERE position_id=? AND type=? AND status='pending'").get(num(b.position_id || b.payload?.position_id), type)
        : db.prepare("SELECT id FROM approval_tasks WHERE application_id=? AND type=? AND status='pending'").get(a.id, type)
      if (dup) conflict(isStrategy ? `该职位已有进行中的「${meta.label}」审批（#${dup.id}），请勿并发发布` : `该候选人已有进行中的「${meta.label}」审批（#${dup.id}），请勿重复提交`, 'task_duplicate')

      // 按类型构造并校验申请内容（提交时预校验业务约束，终审执行时再严格复核）
      const payload = {}
      let interviewId = 0
      let summary = ''
      let posId = 0
      if (isStrategy) {
        posId = num(b.position_id || b.payload?.position_id)
        const pos = db.prepare('SELECT id,name FROM positions WHERE id=?').get(posId)
        if (!pos) return { notFound: true }
        assertNoInFlightStrategy(posId)
        const p = b.payload || {}
        payload.position_id = posId
        payload.weights = p.reset ? { ...DEFAULT_WEIGHTS } : normalizeWeights(p.weights || {})
        payload.keyword_cap = p.reset ? DEFAULT_KEYWORD_CAP : Math.max(0, Math.min(20, num(p.keyword_cap, DEFAULT_KEYWORD_CAP)))
        payload.active_at = parseWindowTime(p.active_at, true)
        payload.canary_end_at = parseWindowTime(p.canary_end_at, false)
        payload.expire_at = parseWindowTime(p.expire_at, false)
        payload.canary_percent = Math.max(0, Math.min(100, Math.round(num(p.canary_percent, 0))))
        payload.recalc = p.recalc !== false
        payload.change_note = String(p.change_note || '').slice(0, 300)
        payload.is_canary = payload.canary_percent > 0 && payload.canary_percent < 100
        payload.is_future = payload.active_at > now()
        if (payload.is_canary && payload.canary_end_at && payload.canary_end_at <= payload.active_at) badRequest('灰度截止时间必须晚于生效开始时间', 'invalid_canary_window')
        if (payload.expire_at && payload.expire_at <= payload.active_at) badRequest('失效时间必须晚于生效开始时间', 'invalid_effective_window')
        summary = payload.is_canary
          ? `${payload.canary_percent}% 灰度发布`
          : payload.is_future ? '定时稳定发布' : '立即稳定发布'
      }
      if (type === 'stage_advance') {
        const target = String(b.payload?.target_stage || '')
        if (a.stage === 'rejected') conflict('候选人已淘汰，请先复活后再提请推进', 'rejected_locked')
        if (NEXT_STAGE[a.stage] !== target) badRequest(`目标阶段应为「${STAGE_LABEL[NEXT_STAGE[a.stage]] || '无'}」`, 'target_mismatch')
        payload.target_stage = target
        payload.from_stage = a.stage
        payload.match_snapshot = parseJSON(a.stage_snapshot || a.match_snapshot, null)
        payload.strategy_id = a.strategy_version_id || payload.match_snapshot?.strategy_id || 0
        payload.strategy_mode = a.strategy_mode || payload.match_snapshot?.strategy_mode || 'stable'
        summary = `推进「${STAGE_LABEL[a.stage]} → ${STAGE_LABEL[target]}」（评分 ${payload.match_snapshot?.score ?? '-'}，策略 v${payload.strategy_id || 0}）`
      } else if (type === 'interview_conclusion') {
        const iv = db.prepare('SELECT * FROM interviews WHERE id=?').get(num(b.payload?.interview_id))
        if (!iv || iv.application_id !== a.id) badRequest('面试记录不存在或不属于该应聘', 'interview_missing')
        const conclusion = String(b.payload?.conclusion || '')
        if (!['pass', 'fail'].includes(conclusion)) badRequest('仅「通过/不通过」结论需要审批；「待定」可直接保存', 'conclusion_invalid')
        const current = iv.conclusion || iv.result || 'pending'
        if (current === conclusion) conflict('该结论已生效，无需重复审批', 'conclusion_same')
        payload.interview_id = iv.id
        payload.conclusion = conclusion
        payload.round = iv.round
        interviewId = iv.id
        summary = `「${iv.round}」结论：${conclusion === 'pass' ? '✅ 通过' : '❌ 不通过'}`
      } else if (type === 'offer_issue') {
        if (a.stage === 'rejected' || a.stage === 'hired') conflict('该候选人流程已终态，不能发起 Offer 审批', 'terminal_locked')
        const exist = offerOfApp(a.id)
        if (exist && exist.status === 'pending') conflict('该候选人已有待回应的 Offer', 'offer_duplicate')
        if (exist && (exist.status === 'accepted' || exist.status === 'joined')) conflict('该候选人的 Offer 已被接受', 'offer_accepted_locked')
        const salary = num(b.payload?.salary, 0)
        if (salary < SALARY_MIN || salary > SALARY_MAX) badRequest(`Offer 月薪需在 ${SALARY_MIN}~${SALARY_MAX} 之间`, 'salary_range')
        // 提交时预校验面试结论门槛，终审执行时还会复核
        if (STAGES.indexOf(a.stage) < STAGES.indexOf('offer')) assertCanEnterOffer(a)
        payload.salary = salary
        payload.due = String(b.payload?.due || '')
        payload.note = String(b.payload?.note || '')
        payload.match_snapshot = parseJSON(a.stage_snapshot || a.match_snapshot, null)
        payload.strategy_id = a.strategy_version_id || payload.match_snapshot?.strategy_id || 0
        payload.strategy_mode = a.strategy_mode || payload.match_snapshot?.strategy_mode || 'stable'
        summary = `月薪 ¥${salary.toLocaleString()}（评分 ${payload.match_snapshot?.score ?? '-'}，策略 v${payload.strategy_id || 0}）`
      }

      const chain = buildChain(type, payload, a || { position_id: posId })
      let taskId
      if (isStrategy) {
        const current = db.prepare('SELECT current_version_id, stable_version_id FROM match_strategies WHERE position_id=?').get(posId)
        const baseVersionId = current?.stable_version_id || current?.current_version_id || 0
        const v = insertStrategyVersion(posId, {
          weights: payload.weights, keywordCap: payload.keyword_cap,
          status: 'pending_approval', activeAt: payload.active_at, canaryEndAt: payload.canary_end_at,
          expireAt: payload.expire_at, canaryPercent: payload.canary_percent,
          baseVersionId, actor: user.name, note: payload.change_note, recalc: payload.recalc
        })
        payload.strategy_version_id = v.id
        const tr = db.prepare(`INSERT INTO approval_tasks(type,application_id,position_id,strategy_version_id,payload,chain,current_step,status,submitted_by,submitted_by_name,submitted_role,submitted_at,version)
                               VALUES('strategy_publish',0,?,?,?,? ,0,'pending',?,?,?,ts(),1)`)
          .run(posId, v.id, JSON.stringify(payload), JSON.stringify(chain), user.id, user.name, user.role)
        taskId = Number(tr.lastInsertRowid)
        db.prepare('UPDATE strategy_versions SET approval_task_id=?, updated_at=? WHERE id=?').run(taskId, ts(), v.id)
        addStrategyEvent({ ...v, approval_task_id: taskId }, 'submit', {
          actor: user.name, note: payload.change_note, approvalTaskId: taskId,
          fromStatus: 'pending_approval', toStatus: 'pending_approval', detail: payload
        })
      } else {
        const r = db.prepare(`INSERT INTO approval_tasks(type,application_id,interview_id,payload,chain,current_step,status,submitted_by,submitted_by_name,submitted_role,submitted_at,version)
                              VALUES(?,?,?,?,?,0,'pending',?,?,?,?,1)`)
          .run(type, a.id, interviewId, JSON.stringify(payload), JSON.stringify(chain), user.id, user.name, user.role, ts())
        taskId = Number(r.lastInsertRowid)
      }
      addStep(taskId, { stepNo: -1, role: user.role, action: 'submit', actor: user, note: summary })
      const cand = a && db.prepare('SELECT name FROM candidates WHERE id=?').get(a.candidate_id)
      const pos = isStrategy
        ? db.prepare('SELECT name FROM positions WHERE id=?').get(posId)
        : db.prepare('SELECT name FROM positions WHERE id=?').get(a.position_id)
      notify({
        recipientRole: chain[0].role, type: 'task_submitted',
        title: `新的${meta.label}审批待处理`,
        body: `${user.name} 提交「${isStrategy ? pos?.name || `职位#${posId}` : `${cand?.name || ''} · ${pos?.name || ''}`}」：${summary}`,
        taskId, appId: a?.id || 0
      })
      return { ok: true, id: taskId, chain }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// 审批决定：approve 逐级通过（终审在同一事务内执行回写）/ return 退回申请人（可修改后重提）
app.post('/api/approvals/:id/decide', (req, res, next) => {
  const user = currentUser(req)
  const b = req.body || {}
  const taskId = num(req.params.id)
  try {
    const out = tx(() => {
      const t = db.prepare('SELECT * FROM approval_tasks WHERE id=?').get(taskId)
      if (!t) return { notFound: true }
      checkVersion(t, b.version)
      if (t.status !== 'pending') conflict('该任务已被处理，请刷新查看最新状态', 'task_closed')
      const chain = parseJSON(t.chain, [])
      const step = chain[t.current_step]
      if (!step) conflict('审批链数据异常', 'chain_broken')
      if (step.role !== user.role) {
        forbidden(`当前节点需「${ROLE_LABEL[step.role]}」审批，您的角色为「${ROLE_LABEL[user.role]}」`, 'role_not_allowed')
      }
      const meta = TASK_TYPES[t.type]
      const note = String(b.note || '')
      const a = t.application_id ? db.prepare('SELECT * FROM applications WHERE id=?').get(t.application_id) : null
      const cand = a && db.prepare('SELECT name FROM candidates WHERE id=?').get(a.candidate_id)
      const posRow = t.position_id ? db.prepare('SELECT name FROM positions WHERE id=?').get(t.position_id) : null
      const pos = a && t.application_id ? db.prepare('SELECT name FROM positions WHERE id=?').get(a.position_id) : posRow
      const who = t.type === 'strategy_publish'
        ? `${posRow?.name || `职位#${t.position_id}`} · 策略 v${t.strategy_version_id}`
        : `${cand?.name || ''} · ${pos?.name || ''}`

      if (b.action === 'return') {
        if (!note.trim()) badRequest('退回必须填写退回意见', 'note_required')
        db.prepare("UPDATE approval_tasks SET status='returned', decided_at=?, decide_note=?, version=version+1 WHERE id=?")
          .run(ts(), note, taskId)
        if (t.type === 'strategy_publish') {
          db.prepare("UPDATE strategy_versions SET status='returned', updated_at=? WHERE id=? AND status='pending_approval'").run(ts(), t.strategy_version_id)
          addStrategyEvent({ id: t.strategy_version_id, position_id: t.position_id, status: 'returned' }, 'return', {
            actor: user.name, note, approvalTaskId: taskId, fromStatus: 'pending_approval', toStatus: 'returned'
          })
        }
        addStep(taskId, { stepNo: t.current_step, role: user.role, action: 'return', actor: user, note })
        notify({
          recipientRole: t.submitted_role, type: 'task_returned',
          title: `${meta.label}审批被退回`,
          body: `${user.name} 退回「${who}」：${note}`,
          taskId, appId: t.application_id
        })
        return { ok: true, status: 'returned' }
      }
      if (b.action !== 'approve') badRequest('未知审批动作', 'unknown_action')

      addStep(taskId, { stepNo: t.current_step, role: user.role, action: 'approve', actor: user, note })
      if (t.current_step + 1 < chain.length) {
        // 中间级通过：流转下一节点并通知下一审批人
        const nextStep = chain[t.current_step + 1]
        db.prepare('UPDATE approval_tasks SET current_step=current_step+1, version=version+1 WHERE id=?').run(taskId)
        notify({
          recipientRole: nextStep.role, type: 'task_submitted',
          title: `${meta.label}审批流转至您`,
          body: `「${who}」已由 ${user.name} 初审通过，待您终审`,
          taskId, appId: t.application_id
        })
        return { ok: true, status: 'pending', next: nextStep.role }
      }

      // 终审通过：SAVEPOINT 内执行回写；业务状态漂移导致失败时仅回滚执行段，任务标记 failed 并通知申请人
      db.exec('SAVEPOINT task_exec')
      let execDesc = '', execErr = null
      try {
        const r = executeApprovalTask(t, user)
        execDesc = r.desc
        db.exec('RELEASE task_exec')
      } catch (e) {
        db.exec('ROLLBACK TO task_exec')
        db.exec('RELEASE task_exec')
        if (!(e instanceof ApiError)) throw e
        execErr = e
      }
      const stamp = ts()
      if (execErr) {
        db.prepare("UPDATE approval_tasks SET status='failed', decided_at=?, decide_note=?, result_note=?, version=version+1 WHERE id=?")
          .run(stamp, note, execErr.message, taskId)
        addStep(taskId, { stepNo: t.current_step, role: user.role, action: 'failed', actor: user, note: `审批通过但执行失败：${execErr.message}` })
        // 危机事件关联的应聘：审批回写失败也是关键处置事件，上链留痕
        auditPassive({
          category: 'decision', action: 'approval.failed', actor: user, applicationId: t.application_id,
          refType: 'approval', refId: taskId,
          summary: `${meta.label}审批通过但执行回写失败：${execErr.message}`,
          detail: { task_id: taskId, type: t.type, error_code: execErr.code, error: execErr.message }
        })
        notify({
          recipientRole: t.submitted_role, type: 'task_failed',
          title: `${meta.label}审批执行失败`,
          body: `「${who}」审批已通过，但回写失败：${execErr.message}`,
          taskId, appId: t.application_id
        })
        return { ok: true, status: 'failed', msg: execErr.message }
      }
      db.prepare("UPDATE approval_tasks SET status='approved', decided_at=?, decide_note=?, result_note=?, version=version+1 WHERE id=?")
        .run(stamp, note, execDesc, taskId)
      addStep(taskId, { stepNo: t.current_step, role: user.role, action: 'execute', actor: user, note: execDesc })
      auditPassive({
        category: 'decision', action: 'approval.execute', actor: user, applicationId: t.application_id,
        refType: 'approval', refId: taskId,
        summary: `${meta.label}终审通过并执行回写：${execDesc}`,
        detail: { task_id: taskId, type: t.type, payload: parseJSON(t.payload, {}), result: execDesc }
      })
      notify({
        recipientRole: t.submitted_role, type: 'task_executed',
        title: `${meta.label}审批通过已生效`,
        body: `「${who}」${execDesc}（终审：${user.name}）`,
        taskId, appId: t.application_id
      })
      return { ok: true, status: 'approved', desc: execDesc }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// 退回后修改重提：整体替换申请内容并按新内容重建审批链（如薪资变化影响加签），从第一级重新审批
app.post('/api/approvals/:id/resubmit', (req, res, next) => {
  const user = currentUser(req)
  const b = req.body || {}
  const taskId = num(req.params.id)
  try {
    const out = tx(() => {
      const t = db.prepare('SELECT * FROM approval_tasks WHERE id=?').get(taskId)
      if (!t) return { notFound: true }
      if (t.status !== 'returned') conflict('仅被退回的任务可以修改后重新提交', 'task_not_returned')
      if (t.submitted_by !== user.id) forbidden('仅原申请人可以重新提交该任务', 'not_submitter')
      const a = db.prepare('SELECT * FROM applications WHERE id=?').get(t.application_id)
      if (!a) return { notFound: true }
      const meta = TASK_TYPES[t.type]
      if (t.type === 'strategy_publish') conflict('策略版本不可改参数重提；请取消后基于当前窗口重新发起新版本', 'strategy_resubmit_unsupported')
      const payload = { ...parseJSON(t.payload, {}) }
      let summary = ''
      if (t.type === 'offer_issue') {
        const salary = num(b.payload?.salary, num(payload.salary))
        if (salary < SALARY_MIN || salary > SALARY_MAX) badRequest(`Offer 月薪需在 ${SALARY_MIN}~${SALARY_MAX} 之间`, 'salary_range')
        payload.salary = salary
        if (b.payload?.due !== undefined) payload.due = String(b.payload.due)
        if (b.payload?.note !== undefined) payload.note = String(b.payload.note)
        if (a.stage === 'rejected' || a.stage === 'hired') conflict('该候选人流程已终态', 'terminal_locked')
        const exist = offerOfApp(a.id)
        if (exist && exist.status === 'pending') conflict('该候选人已有待回应的 Offer', 'offer_duplicate')
        summary = `月薪调整为 ¥${salary.toLocaleString()}`
      } else if (t.type === 'interview_conclusion') {
        const conclusion = String(b.payload?.conclusion || payload.conclusion)
        if (!['pass', 'fail'].includes(conclusion)) badRequest('结论仅支持通过/不通过', 'conclusion_invalid')
        payload.conclusion = conclusion
        summary = `结论改为：${conclusion === 'pass' ? '✅ 通过' : '❌ 不通过'}`
      } else if (t.type === 'stage_advance') {
        // 目标阶段不可改（由当前流程决定）；若流程已漂移，该申请失效，应撤销后重新发起
        if (NEXT_STAGE[a.stage] !== payload.target_stage) {
          badRequest(`流程阶段已变化（当前「${STAGE_LABEL[a.stage]}」），该申请已失效，请撤销后重新发起`, 'stage_mismatch')
        }
        summary = '重新提交推进申请'
      }
      const chain = buildChain(t.type, payload, a)
      db.prepare("UPDATE approval_tasks SET payload=?, chain=?, current_step=0, status='pending', submitted_at=?, decide_note='', version=version+1 WHERE id=?")
        .run(JSON.stringify(payload), JSON.stringify(chain), ts(), taskId)
      addStep(taskId, { stepNo: -1, role: user.role, action: 'resubmit', actor: user, note: summary })
      const cand = db.prepare('SELECT name FROM candidates WHERE id=?').get(a.candidate_id)
      const pos = db.prepare('SELECT name FROM positions WHERE id=?').get(a.position_id)
      notify({
        recipientRole: chain[0].role, type: 'task_resubmitted',
        title: `${meta.label}申请已修改重提`,
        body: `${user.name} 重新提交「${cand?.name || ''} · ${pos?.name || ''}」：${summary}`,
        taskId, appId: a.id
      })
      return { ok: true, status: 'pending', chain }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// 撤销申请：进行中/已退回的任务可由申请人撤销，撤销后释放「同类型唯一进行中」名额
app.post('/api/approvals/:id/cancel', (req, res, next) => {
  const user = currentUser(req)
  const taskId = num(req.params.id)
  try {
    const out = tx(() => {
      const t = db.prepare('SELECT * FROM approval_tasks WHERE id=?').get(taskId)
      if (!t) return { notFound: true }
      if (t.status !== 'pending' && t.status !== 'returned') conflict('该任务已结案，无法撤销', 'task_closed')
      if (t.submitted_by !== user.id) forbidden('仅原申请人可以撤销该任务', 'not_submitter')
      db.prepare("UPDATE approval_tasks SET status='cancelled', decided_at=?, version=version+1 WHERE id=?").run(ts(), taskId)
      if (t.type === 'strategy_publish' && t.strategy_version_id) {
        db.prepare("UPDATE strategy_versions SET status=CASE WHEN status='scheduled' THEN 'cancelled' ELSE 'cancelled' END, updated_at=? WHERE id=?").run(ts(), t.strategy_version_id)
        addStrategyEvent({ id: t.strategy_version_id, position_id: t.position_id, status: 'cancelled' }, 'cancel', {
          actor: user.name, note: String(req.body?.note || ''), approvalTaskId: taskId,
          fromStatus: t.status === 'returned' ? 'returned' : 'pending_approval', toStatus: 'cancelled'
        })
      }
      addStep(taskId, { stepNo: -1, role: user.role, action: 'cancel', actor: user, note: String(req.body?.note || '') })
      if (t.status === 'pending') {
        const chain = parseJSON(t.chain, [])
        const meta = TASK_TYPES[t.type]
        notify({
          recipientRole: chain[t.current_step]?.role || '', type: 'task_cancelled',
          title: `${meta?.label || '审批'}申请已撤销`,
          body: `${user.name} 撤销了「${meta?.label || ''}」申请 #${taskId}`,
          taskId, appId: t.application_id
        })
      }
      return { ok: true, status: 'cancelled' }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// 通知已读：默认把当前身份角色的未读全部标记；也可传 ids 精准标记
app.post('/api/notifications/read', (req, res) => {
  const user = currentUser(req)
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(num).filter(Boolean) : []
  if (ids.length) {
    const marks = ids.map(() => '?').join(',')
    db.prepare(`UPDATE notifications SET is_read=1 WHERE recipient_role=? AND id IN (${marks})`).run(user.role, ...ids)
  } else {
    db.prepare('UPDATE notifications SET is_read=1 WHERE recipient_role=? AND is_read=0').run(user.role)
  }
  res.json({ ok: true })
})

// ---------------- 渠道 ----------------
app.post('/api/channels', (req, res) => {
  const b = req.body || {}
  db.prepare('INSERT INTO channels(name,cost) VALUES(?,?)').run(b.name, num(b.cost, 5000))
  res.json({ ok: true })
})

// 启动迁移：旧库中已有的 matches/applications 归入一个 startup 批次，并补齐投递快照与阶段事件
function migrateHistory() {
  const hadStartupJob = db.prepare("SELECT COUNT(*) c FROM recalc_jobs WHERE trigger_type='startup'").get().c > 0
  const pairRows = db.prepare(`
    SELECT candidate_id, position_id FROM matches
    UNION SELECT candidate_id, position_id FROM applications
  `).all()
  const appsNeedBackfill = db.prepare(`
    SELECT a.* FROM applications a
    WHERE (a.match_snapshot IS NULL OR a.match_snapshot='')
       OR NOT EXISTS (SELECT 1 FROM application_events e WHERE e.application_id=a.id)
  `).all()

  if (!pairRows.length || (hadStartupJob && !appsNeedBackfill.length)) return

  tx(() => {
    let jobId = 0
    const latestStartupJob = hadStartupJob
      ? num(db.prepare("SELECT MAX(id) id FROM recalc_jobs WHERE trigger_type='startup'").get().id || 0)
      : 0
    if (pairRows.length && !hadStartupJob) {
      jobId = createRecalcJob({ triggerType: 'startup', scope: 'startup', triggeredBy: 'system-migration' })
      pairRows.forEach(r => upsertMatch(r.candidate_id, r.position_id, jobId))
      completeRecalcJob(jobId, pairRows.length)
    } else {
      jobId = latestStartupJob
    }

    appsNeedBackfill.forEach(a => {
      let snap = parseJSON(a.match_snapshot, null)
      const latest = resultFromStored(getStoredMatch(a.candidate_id, a.position_id))
      const item = latestJobForPair(a.candidate_id, a.position_id)
      if (!snap) {
        snap = buildSnapshot(a.candidate_id, a.position_id, latest || {
          score: 0, dims: [], reason: '暂无已发布评分', weakness: '暂无评分依据'
        }, {
          stage: 'submitted', stage_label: '投递', event_type: 'advance',
          recalc_job_id: item?.job_id || jobId, backfilled: true
        })
        db.prepare('UPDATE applications SET match_snapshot=?, matched_at=? WHERE id=?')
          .run(JSON.stringify(snap), snap.matched_at, a.id)
      }

      const eventExists = stage => db.prepare('SELECT id FROM application_events WHERE application_id=? AND stage=?').get(a.id, stage)
      const insertRawEvent = (stage, eventType, fromStage, payload) => {
        const enriched = {
          ...payload,
          stage,
          stage_label: { submitted: '投递', screening: '筛选', interview: '面试', offer: 'Offer', hired: '录用', rejected: '淘汰' }[stage] || stage,
          event_type: eventType,
          event_at: payload.event_at || payload.matched_at || ts(),
          backfilled: true
        }
        db.prepare(`INSERT INTO application_events(application_id,stage,from_stage,event_type,event_at,operator,score_snapshot,match_score,strategy_id,strategy_mode,canary_percent,recalc_job_id,backfilled)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)`)
          .run(a.id, stage, fromStage, eventType, enriched.event_at, a.recruiter || 'system-migration',
            JSON.stringify(enriched), num(enriched.score), num(enriched.strategy_id),
            enriched.strategy_mode || 'stable', num(enriched.canary_percent || 0),
            num(enriched.recalc_job_id || item?.job_id || jobId))
      }

      if (!eventExists('submitted')) insertRawEvent('submitted', 'advance', '', snap)
      if (a.stage !== 'submitted' && !eventExists(a.stage)) {
        const order = ['submitted', 'screening', 'interview', 'offer', 'hired']
        const currentIndex = order.indexOf(a.stage)
        const fromStage = currentIndex > 0 ? order[currentIndex - 1] : 'submitted'
        const eventType = a.stage === 'rejected' ? 'reject' : 'advance'
        const stageSnap = buildSnapshot(a.candidate_id, a.position_id, latest || snap, {
          recalc_job_id: item?.job_id || jobId
        })
        insertRawEvent(a.stage, eventType, a.stage === 'rejected' ? fromStage : fromStage, stageSnap)
      }
    })

    // 补录事件落库后回填当前阶段快照/进入时间（可能来自补录事件；正式事件由 db.js 兼容段优先处理）
    db.prepare(`UPDATE applications SET stage_snapshot=(
                  SELECT e.score_snapshot FROM application_events e
                  WHERE e.application_id=applications.id AND e.stage=applications.stage
                  ORDER BY e.id DESC LIMIT 1),
                entered_at=(
                  SELECT e.event_at FROM application_events e
                  WHERE e.application_id=applications.id AND e.stage=applications.stage
                  ORDER BY e.id DESC LIMIT 1)
                WHERE stage_snapshot=''`).run()

    if (jobId) console.log(`[HR] startup recalc job #${jobId} refreshed ${pairRows.length} pairs`)
    if (appsNeedBackfill.length) console.log(`[HR] backfilled trace events for ${appsNeedBackfill.length} applications`)
  })
}
migrateHistory()
try {
  const sweepResult = tx(() => runStrategySweep({ actor: 'system-startup' }))
  if (sweepResult.activated.length || sweepResult.expired.length || sweepResult.canary_ended.length) {
    console.log(`[HR] strategy sweep activated=${sweepResult.activated.length}, canaryEnded=${sweepResult.canary_ended.length}, expired=${sweepResult.expired.length}`)
  }
} catch (e) {
  console.error('[HR] strategy sweep failed:', e)
}

// 挂载跨角色危机处置审计模块（路由 + 哈希链 + 责任回写），并注入主流程回退执行器
bindCrisisCore({ rollbackForIncident })
app.use('/api/crisis', crisisRouter)
// 候选人↔面试官双向预约沟通（可用时段/双向确认改期/提醒/缺席处理）
app.use('/api/schedule', scheduleRouter)

// 统一业务错误出口：ApiError 携带状态码与错误码，其余错误按 500 返回
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ApiError) return res.status(err.status).json({ ok: false, code: err.code, msg: err.message })
  // 危机模块（独立 express.Router）抛出的带状态业务错误
  if (err?.status && err?.code) return res.status(err.status).json({ ok: false, code: err.code, msg: err.message })
  console.error('[HR] unhandled error:', err)
  res.status(500).json({ ok: false, code: 'internal', msg: '服务内部错误' })
})

app.listen(PORT, () => console.log(`[HR] API running at http://localhost:${PORT}`))