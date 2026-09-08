<script setup lang="ts">
import { computed, ref } from 'vue'

/**
 * 预问诊（患者端）。
 *
 * 患者候诊时自己填，医生一进来就看得到。设计稿：Figma「12 · 移动端重构」①–⑤。
 *
 * ## 这条路上有三条硬约束
 *
 * **① 只填自己的情况。** 诊断、检验、风险一个字都不出现在这个组件里 ——
 * 接口本来也不下发（见 `routers/previsit.py`），两头都不给才算数。
 *
 * **② 登录失败原样转述服务端那一句。** 前端不许自己拼「姓名错误」之类的
 * 提示：那等于把服务端刻意抹掉的区分又还回去了。
 *
 * **③ 过敏题必须说清「医生还会再问一次」。** 患者自报不改档案状态，
 * 不说清楚，他会以为填了就算数，医生再问时反而觉得系统没记住。
 *
 * ## 字号
 *
 * 正文 16–19px。这是全局默认字号上调之后的基准 —— 患者端尤其不能小，
 * 用它的人正在候诊区、光线差、可能还上了年纪。
 */

type Answer = {
  choice?: string
  choices?: string[]
  text?: string
  date?: string
  pair?: [string, string]
}
interface Question {
  key: string
  label: string
  hint?: string
  type: string
  options?: string[]
  text_when?: string
  text_placeholder?: string
  notice?: string
  pair_labels?: [string, string]
}

const step = ref<'login' | 'form' | 'done'>('login')
const pid = ref('')
const name = ref('')
const error = ref('')
const busy = ref(false)
const deptName = ref('')
const common = ref<Question[]>([])
const dept = ref<Question[]>([])
const answers = ref<Record<string, Answer>>({})

const canLogin = computed(() => pid.value.trim().length > 0 && name.value.trim().length > 0)
const questions = computed(() => [...common.value, ...dept.value])

async function doLogin() {
  if (!canLogin.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const res = await fetch('/api/previsit/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patient_id: pid.value.trim(), name: name.value.trim() }),
    })
    const body = await res.json()
    if (!res.ok) {
      // **原样转述。** 自己拼一句「姓名不对」，就把服务端刻意抹掉的区分还回去了
      error.value = body.detail || '登录失败'
      return
    }
    deptName.value = body.dept || ''
    const q = await fetch(
      `/api/previsit/questions/${encodeURIComponent(body.patient_id)}`,
    ).then((r) => r.json())
    common.value = q.common ?? []
    dept.value = q.dept ?? []
    step.value = 'form'
  } catch {
    error.value = '网络不太好，请稍后再试'
  } finally {
    busy.value = false
  }
}

function pick(q: Question, opt: string) {
  const cur = answers.value[q.key] ?? {}
  if (q.type === 'multi_text') {
    const set = new Set(cur.choices ?? [])
    if (set.has(opt)) set.delete(opt)
    else set.add(opt)
    answers.value = { ...answers.value, [q.key]: { ...cur, choices: [...set] } }
    return
  }
  // 再点一次取消：选错了要能改回未选，而不是只能换一个
  const next = cur.choice === opt ? '' : opt
  answers.value = { ...answers.value, [q.key]: { ...cur, choice: next } }
}

const chosen = (q: Question, opt: string) =>
  q.type === 'multi_text'
    ? (answers.value[q.key]?.choices ?? []).includes(opt)
    : answers.value[q.key]?.choice === opt

/** 补充输入框：只在「选了触发项」时出现。选「没有」还留个框会让人以为必须填点什么 */
const showFollowUp = (q: Question) =>
  q.type === 'multi_text'
    ? (answers.value[q.key]?.choices ?? []).includes('其他')
    : !!q.text_when && answers.value[q.key]?.choice === q.text_when

function setText(q: Question, v: string) {
  answers.value = { ...answers.value, [q.key]: { ...(answers.value[q.key] ?? {}), text: v } }
}
function setDate(q: Question, v: string) {
  answers.value = { ...answers.value, [q.key]: { ...(answers.value[q.key] ?? {}), date: v } }
}
function setPair(q: Question, i: 0 | 1, v: string) {
  const cur = (answers.value[q.key]?.pair ?? ['', '']) as [string, string]
  cur[i] = v
  answers.value = {
    ...answers.value,
    [q.key]: { ...(answers.value[q.key] ?? {}), pair: [...cur] as [string, string] },
  }
}

const answered = computed(
  () =>
    Object.values(answers.value).filter(
      (a) => a.choice || a.choices?.length || a.text || a.date || a.pair?.some(Boolean),
    ).length,
)

async function submit() {
  if (busy.value) return
  busy.value = true
  try {
    const res = await fetch('/api/previsit/answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // **姓名要一起带上。** 只带病人号的话，拿到号码就能替别人填
      body: JSON.stringify({
        patient_id: pid.value.trim(),
        name: name.value.trim(),
        answers: answers.value,
      }),
    })
    if (res.ok) step.value = 'done'
    else error.value = '提交没成功，请再试一次'
  } catch {
    error.value = '网络不太好，请稍后再试'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="pv-page">
    <!-- ─────────────────────────── 登录 -->
    <template v-if="step === 'login'">
      <div class="pv-body">
        <div class="pv-hero">
          <span class="pv-org">北京大学国际医院</span>
          <h1 class="pv-h1">先确认是你本人</h1>
          <p class="pv-lead">用挂号单或就诊卡上的号码。</p>
        </div>

        <label class="pv-label">病人号</label>
        <input v-model="pid" class="pv-input" inputmode="text" placeholder="P0000000" />
        <p class="pv-hint">挂号单右上角，P 开头</p>

        <label class="pv-label">姓名</label>
        <input v-model="name" class="pv-input" placeholder="请输入您的姓名" />
        <p class="pv-hint">与挂号时填写的一致</p>

        <p v-if="error" class="pv-error">{{ error }}</p>

        <button class="pv-primary" type="button" :disabled="!canLogin || busy" @click="doLogin">
          {{ busy ? '核对中…' : '下一步' }}
        </button>
        <p class="pv-foot">
          两项都对上才能进。对不上不会说是哪一项错了 —— 那等于让人拿号码去试姓名。
        </p>
      </div>
    </template>

    <!-- ─────────────────────────── 填写 -->
    <template v-else-if="step === 'form'">
      <div class="pv-top">
        <span class="pv-top-name">{{ name }} · {{ deptName }}</span>
        <span class="pv-top-step">已填 {{ answered }} / {{ questions.length }}</span>
      </div>
      <div class="pv-body pv-scroll">
        <p class="pv-lead pv-lead-tight">
          花 2 分钟把情况说清楚，医生一进来就看得到。<b>不确定就选「记不清」</b>——
          猜一个反而会误导医生。
        </p>

        <section v-for="(q, i) in questions" :key="q.key" class="pv-question">
          <div class="pv-q-head">
            <span class="pv-q-num">{{ i + 1 }}</span>
            <span class="pv-q-label">{{ q.label }}</span>
          </div>
          <p v-if="q.hint" class="pv-q-hint">{{ q.hint }}</p>

          <div v-if="q.type === 'date'" class="pv-date">
            <input
              class="pv-input pv-input-inline"
              type="date"
              :value="answers[q.key]?.date ?? ''"
              @input="setDate(q, ($event.target as HTMLInputElement).value)"
            />
          </div>
          <div v-if="q.type === 'pair'" class="pv-pair">
            <label v-for="(lab, pi) in q.pair_labels ?? []" :key="lab" class="pv-pair-col">
              <span class="pv-pair-lab">{{ lab }}</span>
              <input
                class="pv-input pv-input-inline"
                inputmode="numeric"
                :value="answers[q.key]?.pair?.[pi] ?? ''"
                @input="setPair(q, pi as 0 | 1, ($event.target as HTMLInputElement).value)"
              />
            </label>
          </div>

          <div v-if="q.options?.length" class="pv-chips">
            <button
              v-for="opt in q.options"
              :key="opt"
              class="pv-chip"
              type="button"
              :class="{ on: chosen(q, opt) }"
              @click="pick(q, opt)"
            >
              {{ opt }}
            </button>
          </div>

          <input
            v-if="showFollowUp(q) || q.type === 'text'"
            class="pv-input pv-followup"
            :placeholder="q.text_placeholder ?? '请补充'"
            :value="answers[q.key]?.text ?? ''"
            @input="setText(q, ($event.target as HTMLInputElement).value)"
          />

          <p v-if="q.notice" class="pv-notice">ⓘ {{ q.notice }}</p>
        </section>

        <p v-if="error" class="pv-error">{{ error }}</p>
        <button class="pv-submit" type="button" :disabled="busy" @click="submit">
          {{ busy ? '提交中…' : '提交给医生' }}
        </button>
      </div>
    </template>

    <!-- ─────────────────────────── 完成 -->
    <template v-else>
      <div class="pv-body pv-done">
        <span class="pv-tick">✓</span>
        <h1 class="pv-h1">已经交给医生了</h1>
        <p class="pv-lead pv-center">
          医生叫号时会看到你填的内容，<br />不用再重复说一遍。
        </p>
        <button class="pv-ghost" type="button" @click="step = 'form'">修改我填的内容</button>
        <p class="pv-foot pv-center">医生开始接诊后就不能改了 —— 病历要能对上当时说的话。</p>
      </div>
    </template>
  </div>
</template>

<style scoped src="../styles/PreVisit.scoped.css"></style>
