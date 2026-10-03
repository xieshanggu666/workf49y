<script setup>
import { computed, ref } from 'vue'
import { useHrStore } from '@/store/hr'

const store = useHrStore()
const open = ref(false)
const editing = ref(null)
const form = ref({ name: '', dept: '技术部', city: '上海', level: 'P5', salary_min: 15000, salary_max: 30000, years: 2, slots: 1 })
const skillInput = ref('')
const skills = ref([])

const depts = ['技术部', '产品部', '设计部', '数据部', '质量部', '市场部']
const cities = ['北京', '上海', '深圳', '杭州', '广州', '成都', '武汉', '南京']

const appCount = pid => store.applications.filter(a => a.position_id === pid).length

// ---------------- 按职位匹配策略 ----------------
const DIM_META = [
  { k: 'skill', label: '技能匹配' },
  { k: 'year', label: '经验年限' },
  { k: 'salary', label: '薪资带宽' },
  { k: 'edu', label: '学历' },
  { k: 'city', label: '城市地点' }
]
const strategyOpen = ref(false)
const strategyPos = ref(null)
const strategyForm = ref({ weights: {}, keyword_cap: 5 })
const strategyVersionsData = ref([])
const strategyAdvanced = ref({ active_at: '', canary_percent: 0, canary_end_at: '', expire_at: '', change_note: '', direct: false })
const strategySaving = ref(false)
const strategyMsg = ref('')
const weightPct = k => Math.round((strategyForm.value.weights[k] || 0) * 100)
const weightSumPct = computed(() => Object.values(strategyForm.value.weights).reduce((s, v) => s + (Number(v) || 0), 0))
const lastVersionOf = pid => store.strategyVersions.find(v => v.position_id === pid) || null
const strategyStatusMeta = {
  pending_approval: ['⏳ 待审批', 'warn'], scheduled: ['🕒 待生效', 'warn'], canary: ['🧪 灰度中', 'canary'],
  canary_ended: ['↩️ 灰度已结束', 'muted'], active: ['✅ 生效中', 'ok'], retired: ['📦 已退役', 'muted'],
  cancelled: ['🚫 已取消', 'muted'], returned: ['↩️ 已退回', 'danger'], rolled_back: ['⛔ 已回滚', 'danger']
}
function fmtTime(t) { return t ? String(t).replace('T', ' ').slice(0, 16) : '' }
function toLocalInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const currentGovernance = computed(() => strategyPos.value ? store.positions.find(p => p.id === strategyPos.value.id)?.strategyGovernance : null)
const canaryVersion = computed(() => currentGovernance.value?.canaryVersion || null)
const stableVersion = computed(() => currentGovernance.value?.stableVersion || null)

async function openStrategy(p) {
  strategyPos.value = p
  strategyMsg.value = ''
  const r = await store.getStrategy(p.id)
  const st = r.strategy || {}
  strategyForm.value = { weights: { ...(st.weights || store.defaultStrategy.weights) }, keyword_cap: st.keywordCap ?? store.defaultStrategy.keywordCap }
  strategyVersionsData.value = r.versions || []
  strategyAdvanced.value = { active_at: '', canary_percent: 0, canary_end_at: '', expire_at: '', change_note: '', direct: false }
  strategyOpen.value = true
}
function setWeight(k, pct) { strategyForm.value.weights[k] = Math.round(Number(pct)) / 100 }
async function submitStrategy(reset = false) {
  strategySaving.value = true
  strategyMsg.value = ''
  const payload = {
    reset,
    weights: strategyForm.value.weights,
    keyword_cap: Number(strategyForm.value.keyword_cap),
    published_by: 'HR',
    change_note: strategyAdvanced.value.change_note,
    canary_percent: reset ? 0 : Number(strategyAdvanced.value.canary_percent || 0),
    active_at: !reset && strategyAdvanced.value.active_at ? new Date(strategyAdvanced.value.active_at).toISOString() : '',
    canary_end_at: !reset && strategyAdvanced.value.canary_end_at ? new Date(strategyAdvanced.value.canary_end_at).toISOString() : '',
    expire_at: !reset && strategyAdvanced.value.expire_at ? new Date(strategyAdvanced.value.expire_at).toISOString() : '',
    // 默认纳入用人经理审批；勾选“紧急直发”才保留旧版立即发布行为
    direct: strategyAdvanced.value.direct
  }
  if (payload.direct) payload.recalc = true
  const r = await store.publishStrategy(strategyPos.value.id, payload)
  strategySaving.value = false
  if (r?.ok) {
    strategyMsg.value = r.approval_task_id
      ? `策略 v${r.strategy?.versionId} 已提交审批（任务 #${r.approval_task_id}）`
      : `策略 v${r.strategy?.versionId} 已发布，批次 #${r.job_id || '-'} 已重算 ${r.recalced} 个候选人`
    setTimeout(() => { strategyOpen.value = false }, 1200)
  } else {
    strategyMsg.value = '发布失败，请重试'
  }
}

async function promoteCanary() {
  if (!canaryVersion.value) return
  const note = prompt('确认将灰度版本转正为全量稳定策略？请填写观察结论', '灰度指标正常，转正全量')
  if (!note) return
  await store.promoteStrategy(canaryVersion.value.versionId, note)
  await openStrategy(strategyPos.value)
}
async function stopCanary() {
  if (!canaryVersion.value) return
  const note = prompt('结束灰度并恢复基线策略？请填写回滚原因', '灰度指标异常，立即恢复基线')
  if (!note) return
  await store.endStrategyCanary(canaryVersion.value.versionId, note)
  await openStrategy(strategyPos.value)
}
async function cancelVersion(v) {
  const note = prompt(`确认取消策略 v${v.versionId || v.id}？可填写原因`, '发布计划变更')
  if (!note) return
  await store.cancelStrategy(v.versionId || v.id, note)
  await openStrategy(strategyPos.value)
}
async function rollbackStrategy() {
  const note = prompt('确认创建一个回滚版本？可恢复到上一稳定版本或默认策略', '紧急回滚异常策略')
  if (!note) return
  const versionId = canaryVersion.value ? (canaryVersion.value.baseVersionId || 0) : (stableVersion.value?.versionId || 0)
  await store.rollbackStrategy(strategyPos.value.id, { version_id: versionId, note })
  await openStrategy(strategyPos.value)
}

function openNew() {
  editing.value = null
  form.value = { name: '', dept: '技术部', city: '上海', level: 'P5', salary_min: 15000, salary_max: 30000, years: 2, slots: 1 }
  skills.value = []
  skillInput.value = ''
  open.value = true
}
function openEdit(p) {
  editing.value = p
  form.value = { name: p.name, dept: p.dept, city: p.city, level: p.level, salary_min: p.salary_min, salary_max: p.salary_max, years: p.years, slots: p.slots }
  skills.value = p.skills.map(s => ({ ...s }))
  skillInput.value = ''
  open.value = true
}
function addSkill() {
  const k = skillInput.value.trim()
  if (k) skills.value.push({ k, w: 5 })
  skillInput.value = ''
}
function submit() {
  const payload = { ...form.value, skills: skills.value }
  if (editing.value) store.updatePosition(editing.value.id, { status: 'open' })
  else store.addPosition(payload)
  open.value = false
}
</script>

<template>
  <div class="positions">
    <div class="bar">
      <span class="muted">共 {{ store.positions.length }} 个职位 · 在招 {{ store.openPositions.length }}</span>
      <button class="primary" @click="openNew">＋ 发布职位</button>
    </div>

    <div class="cards">
      <div class="pcard card" v-for="p in store.positions" :key="p.id" :class="{ closed: p.status === 'closed' }">
        <div class="phead">
          <div>
            <b>{{ p.name }}</b>
            <span class="tag" :class="p.status">{{
            p.status === 'open' ? '🔥 招聘中' : '⏸ 已关闭' }}</span>
          </div>
          <div class="meta muted">
            <span>🏢 {{ p.dept }}</span><span>📍 {{ p.city }}</span><span>{{ p.level }}</span>
          </div>
        </div>
        <div class="sal money">¥{{ p.salary_min.toLocaleString() }} - {{ p.salary_max.toLocaleString() }}</div>
        <div class="chips">
          <span class="skill-chip" v-for="s in p.skills" :key="s.k">{{ s.k }} <i>x{{ s.w }}</i></span>
        </div>
        <div class="pmeta muted">
          <span>经验 {{ p.years }} 年+</span><span>编制 {{ p.slots }}</span><span>应聘 {{ appCount(p.id) }}</span>
        </div>
        <div class="stline">
          <span class="st-tag" :class="lastVersionOf(p.id)?.status || 'default'">
            <template v-if="lastVersionOf(p.id)">
              ⚙️ {{ strategyStatusMeta[lastVersionOf(p.id).status]?.[0] || `策略 v${lastVersionOf(p.id).id}` }}
            </template>
            <template v-else>⚙️ 默认匹配策略 v0</template>
          </span>
          <span class="muted st-w" v-if="lastVersionOf(p.id)">
            v{{ lastVersionOf(p.id).id }} ·
            技{{ Math.round(lastVersionOf(p.id).weights.skill * 100) }}% · 薪{{ Math.round(lastVersionOf(p.id).weights.salary * 100) }}% · 词+{{ lastVersionOf(p.id).keyword_cap }}
            <em v-if="lastVersionOf(p.id).canary_percent"> · 灰度{{ lastVersionOf(p.id).canary_percent }}%</em>
          </span>
        </div>
        <div class="acts">
          <button class="ghost" @click="openEdit(p)">编辑</button>
          <button class="ghost" @click="openStrategy(p)">⚙️ 匹配策略</button>
          <button class="warn" v-if="p.status === 'open'" @click="store.updatePosition(p.id, { status: 'closed' })">关闭职位</button>
          <button class="succ" v-else @click="store.updatePosition(p.id, { status: 'open' })">重新开放</button>
        </div>
      </div>
    </div>

    <div class="modal" v-if="open">
      <div class="modal-box card">
        <h3>{{ editing ? '✏️ 编辑职位' : '📌 发布新职位' }}</h3>
        <div class="form">
          <div class="fg">
            <label>职位名称<input v-model="form.name" placeholder="如 前端开发工程师" /></label>
            <label>部门<select v-model="form.dept"><option v-for="d in depts" :key="d">{{ d }}</option></select></label>
          </div>
          <div class="fg">
            <label>城市<select v-model="form.city"><option v-for="c in cities" :key="c">{{ c }}</option></select></label>
            <label>职级<select v-model="form.level"><option v-for="l in ['P4','P5','P6','P7','P8']" :key="l">{{ l }}</option></select></label>
          </div>
          <div class="fg">
            <label>最低薪资<input type="number" v-model.number="form.salary_min" /></label>
            <label>最高薪资<input type="number" v-model.number="form.salary_max" /></label>
          </div>
          <div class="fg">
            <label>经验年限<input type="number" v-model.number="form.years" /></label>
            <label>编制人数<input type="number" v-model.number="form.slots" /></label>
          </div>
          <label>技能要求（权重5=必备）</label>
          <div class="skill-editor">
            <input v-model="skillInput" placeholder="输入技能回车添加" @keyup.enter="addSkill" />
            <button class="ghost" @click="addSkill">＋ 添加</button>
          </div>
          <div class="edit-chips">
            <span v-for="(s, i) in skills" :key="i" class="chipx">
              {{ s.k }}<select v-model.number="s.w"><option :value="1">1</option><option :value="2">2</option><option :value="3">3</option><option :value="4">4</option><option :value="5">5</option></select>
              <button class="x" @click="skills.splice(i, 1)">✕</button>
            </span>
          </div>
        </div>
        <div class="acts">
          <button class="primary" @click="submit">{{ editing ? '保存' : '发布' }}</button>
          <button class="ghost" @click="open = false">取消</button>
        </div>
      </div>
    </div>

    <!-- 按职位配置/发布匹配策略 -->
    <div class="modal" v-if="strategyOpen">
      <div class="modal-box card">
        <h3>⚙️ 匹配策略 · {{ strategyPos?.name }}</h3>
        <div class="st-tip muted">
          发布将生成不可变策略版本。默认提交用人经理审批；到生效窗口后联动批量重算。
          灰度期间按候选人稳定分桶路由，<b>投递与阶段评分快照永不改变</b>，转正/回滚均创建可审计批次。
        </div>
        <div v-if="canaryVersion" class="canary-banner">
          <b>🧪 当前灰度 v{{ canaryVersion.versionId }}（{{ canaryVersion.canaryPercent }}%）</b>
          <span>观察截止：{{ fmtTime(canaryVersion.canaryEndAt) || '未设置' }} · 基线 v{{ canaryVersion.baseVersionId || 0 }}</span>
          <div class="acts">
            <button class="succ" @click="promoteCanary">✅ 转正全量</button>
            <button class="warn" @click="stopCanary">↩️ 结束灰度/回基线</button>
          </div>
        </div>
        <div class="st-form">
          <div class="st-row" v-for="d in DIM_META" :key="d.k">
            <label>{{ d.label }}</label>
            <input type="range" min="0" max="100" step="5" :value="weightPct(d.k)" @input="setWeight(d.k, $event.target.value)" />
            <b>{{ weightPct(d.k) }}%</b>
          </div>
          <div class="st-row">
            <label>简历关键词加分上限</label>
            <input type="range" min="0" max="10" step="1" v-model.number="strategyForm.keyword_cap" />
            <b>+{{ strategyForm.keyword_cap }}</b>
          </div>
          <div class="st-window">
            <label>生效开始<input type="datetime-local" v-model="strategyAdvanced.active_at"></label>
            <label>灰度比例（0=稳定发布）<input type="number" min="0" max="100" step="5" v-model.number="strategyAdvanced.canary_percent"></label>
            <label>灰度截止<input type="datetime-local" v-model="strategyAdvanced.canary_end_at" :disabled="!strategyAdvanced.canary_percent || strategyAdvanced.canary_percent >= 100"></label>
            <label>策略失效时间（可选）<input type="datetime-local" v-model="strategyAdvanced.expire_at"></label>
          </div>
          <label class="note-label">变更说明 / 审批备注<input v-model="strategyAdvanced.change_note" placeholder="如：提高技能权重以降低误筛；灰度观察通过率"></label>
          <label class="direct-line"><input type="checkbox" v-model="strategyAdvanced.direct"> 紧急直发（跳过审批；历史调用兼容，生产建议保留审批）</label>
        </div>
        <div class="st-sum" :class="{ ok: weightSumPct === 1, bad: weightSumPct !== 1 }">
          权重合计 {{ Math.round(weightSumPct * 100) }}%
          <em v-if="weightSumPct !== 1">（发布时将自动归一化为 100%）</em>
        </div>
        <div v-if="strategyMsg" class="st-msg">✅ {{ strategyMsg }}</div>
        <div class="version-history" v-if="strategyVersionsData.length">
          <div v-if="canaryVersion" class="vh-head"><b>版本治理记录</b><button class="ghost tiny" @click="rollbackStrategy">紧急回滚基线</button></div>
          <div v-else class="vh-head"><b>版本治理记录</b><span class="muted">无灰度时可从历史版本另行回滚</span></div>
          <div v-for="v in strategyVersionsData.slice(0, 6)" :key="v.versionId" class="vh-row">
            <span class="ver">v{{ v.versionId }}</span>
            <span class="state">{{ strategyStatusMeta[v.status]?.[0] || v.status }}</span>
            <span class="muted">{{ fmtTime(v.activeAt || v.publishedAt) }}</span>
            <em v-if="v.canaryPercent">灰度{{ v.canaryPercent }}%</em>
            <button v-if="['pending_approval','scheduled'].includes(v.status)" class="ghost tiny" @click="cancelVersion(v)">取消</button>
          </div>
        </div>
        <div class="acts">
          <button class="primary" :disabled="strategySaving" @click="submitStrategy(false)">提交版本发布</button>
          <button class="warn" :disabled="strategySaving" @click="submitStrategy(true)">恢复默认并提交</button>
          <button class="ghost" @click="strategyOpen = false">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.positions { display: flex; flex-direction: column; gap: 14px; }
.bar { display: flex; justify-content: space-between; align-items: center; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
.pcard { display: flex; flex-direction: column; gap: 10px; }
.pcard.closed { opacity: .6; }
.phead { display: flex; justify-content: space-between; align-items: flex-start; }
.phead b { font-size: 16px; }
.meta { display: flex; gap: 8px; font-size: 12px; }
.sal { font-size: 15px; }
.chips { display: flex; flex-wrap: wrap; }
.chips i { font-style: normal; opacity: .7; font-size: 10px; }
.pmeta { display: flex; gap: 12px; font-size: 12px; }
.tag.open { background: rgba(87,214,160,.15); color: var(--green); border-color: rgba(87,214,160,.4); }
.tag.closed { background: rgba(140,149,176,.1); }
.acts { display: flex; gap: 6px; }
.form { display: flex; flex-direction: column; gap: 10px; margin: 14px 0; }
.fg { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.form label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--muted); }
.skill-editor { display: flex; gap: 8px; }
.skill-editor input { flex: 1; }
.edit-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chipx { display: inline-flex; align-items: center; gap: 4px; background: rgba(91,140,255,.14); border: 1px solid rgba(91,140,255,.35); padding: 2px 6px; border-radius: 10px; font-size: 12px; }
.chipx select { background: transparent; border: none; color: var(--accent2); width: 34px; }
.chipx .x { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 11px; padding: 0 2px; }
.stline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.st-tag { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--panel2); border: 1px solid var(--border); color: var(--muted); }
.st-tag.custom { background: rgba(167,139,250,.15); color: var(--purple); border-color: rgba(167,139,250,.4); }
.st-w { font-size: 11px; }
.st-tip { line-height: 1.7; margin: 8px 0 12px; }
.st-tip b { color: var(--green); font-weight: 600; }
.st-form { display: flex; flex-direction: column; gap: 10px; }
.st-row { display: grid; grid-template-columns: 130px 1fr 48px; align-items: center; gap: 10px; font-size: 13px; }
.st-row input[type=range] { width: 100%; padding: 0; accent-color: var(--accent); }
.st-row b { text-align: right; color: var(--accent2); }
.st-sum { margin: 12px 0; font-size: 13px; padding: 8px 10px; border-radius: 8px; background: var(--panel2); }
.st-sum.ok { color: var(--green); }
.st-sum.bad { color: var(--accent2); }
.st-sum em { font-style: normal; font-size: 11px; color: var(--muted); }
.st-msg { margin-bottom: 10px; font-size: 12px; color: var(--green); }
.st-tag.active { background: rgba(87,214,160,.15); color: var(--green); border-color: rgba(87,214,160,.4); }
.st-tag.canary { background: rgba(255,209,102,.13); color: var(--accent2); border-color: rgba(255,209,102,.42); }
.st-tag.pending_approval, .st-tag.scheduled, .st-tag.returned { background: rgba(91,140,255,.13); color: var(--accent); border-color: rgba(91,140,255,.35); }
.st-tag.retired, .st-tag.cancelled, .st-tag.canary_ended, .st-tag.rolled_back { color: var(--muted); }
.st-window { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; margin: 12px 0; }
.st-window label, .note-label { font-size: 12px; color: var(--muted); display: flex; flex-direction: column; gap: 4px; }
.st-window input, .note-label input { padding: 7px 8px; }
.note-label { margin-bottom: 8px; }
.direct-line { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--accent2); }
.canary-banner { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 9px 10px; margin: 10px 0; border: 1px solid rgba(255,209,102,.35); border-radius: 8px; background: rgba(255,209,102,.08); font-size: 12px; }
.canary-banner .acts { margin-left: auto; }
.version-history { border-top: 1px dashed var(--border); padding-top: 10px; margin-bottom: 10px; }
.vh-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-size: 12px; }
.vh-row { display: grid; grid-template-columns: 44px 92px 1fr auto auto; gap: 8px; align-items: center; font-size: 11px; padding: 4px 0; }
.vh-row em { font-style: normal; color: var(--accent2); }
.tiny { padding: 2px 7px; font-size: 11px; }
</style>