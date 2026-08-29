import { ref } from 'vue'

import { api, streamSse } from '../api'

/**
 * 语音问诊（F01）。
 *
 * 分工要看清：
 *   - 语音转文字（ASR）用浏览器 Web Speech API，不可用时降级为手动输入。
 *     这是一期唯一保留模拟的部分。
 *   - 追问建议与观察项提取是真实模型输出，走 /api/emr/voice/turn。
 *
 * 产出的是**给医生的下一句追问建议**，不是替医生向患者提问。
 */

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
}

type RecognitionCtor = new () => SpeechRecognitionLike

function getRecognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function useVoiceInterview(getPatientId: () => string) {
  const ctor = getRecognitionCtor()
  const supported = ctor !== null

  const active = ref(false)
  const listening = ref(false)
  const thinking = ref(false)
  const transcript = ref('')
  const turnIndex = ref(0)
  const messages = ref<{ role: 'doctor' | 'patient'; text: string }[]>([])
  const observations = ref<string[]>([])
  const error = ref('')

  let recognition: SpeechRecognitionLike | null = null

  async function start() {
    const patientId = getPatientId()
    if (!patientId) return
    active.value = true
    error.value = ''
    messages.value = []
    observations.value = []
    turnIndex.value = 0

    try {
      const init = await api.voiceInit(patientId)
      messages.value.push({ role: 'doctor', text: init.greeting })
    } catch (exc) {
      error.value = `问诊初始化失败：${(exc as Error).message}`
    }
  }

  function toggleListening() {
    if (!supported) {
      error.value = '当前浏览器不支持语音识别，请在下方手动输入患者所述内容。'
      return
    }
    if (listening.value) {
      recognition?.stop()
      return
    }

    recognition = new ctor!()
    recognition.lang = 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.onresult = (event) => {
      let text = ''
      for (let i = 0; i < event.results.length; i += 1) {
        text += event.results[i][0].transcript
      }
      // ASR 结果必须可编辑，不直接作为病历事实
      transcript.value = text
    }
    recognition.onerror = (event) => {
      error.value = `语音识别出错（${event.error}），可改为手动输入。`
      listening.value = false
    }
    recognition.onend = () => {
      listening.value = false
    }

    try {
      recognition.start()
      listening.value = true
      error.value = ''
    } catch {
      error.value = '无法启动语音识别，请检查麦克风权限，或手动输入。'
    }
  }

  async function submitTurn() {
    const patientId = getPatientId()
    const text = transcript.value.trim()
    if (!patientId || !text || thinking.value) return

    recognition?.stop()
    messages.value.push({ role: 'patient', text })
    transcript.value = ''
    thinking.value = true

    // 先占位，逐字流入这一条
    messages.value.push({ role: 'doctor', text: '' })
    const index = messages.value.length - 1

    try {
      await streamSse(
        '/api/emr/voice/turn',
        {
          patient_id: patientId,
          patient_text: text,
          turn_index: turnIndex.value,
          conversation_history: messages.value.slice(0, -1),
        },
        (event) => {
          if (event.type === 'prompt_token') {
            messages.value[index].text += String(event.token)
          } else if (event.type === 'prompt_done') {
            turnIndex.value = Number(event.turn_index ?? turnIndex.value + 1)
            observations.value = [...observations.value, ...((event.observations as string[]) ?? [])]
            if (event.degraded) {
              error.value = '模型不可用，追问建议为通用问法，本轮未提取观察项。'
            }
          }
        },
      )
    } catch (exc) {
      messages.value[index].text = `（追问建议获取失败：${(exc as Error).message}）`
    } finally {
      thinking.value = false
    }
  }

  async function finish() {
    const patientId = getPatientId()
    recognition?.stop()
    listening.value = false

    if (patientId && messages.value.length) {
      try {
        await api.voiceComplete({
          patient_id: patientId,
          conversation_summary: messages.value.map((m) => `${m.role === 'doctor' ? '医生' : '患者'}：${m.text}`).join('\n'),
          messages: messages.value,
        })
      } catch (exc) {
        error.value = `问诊小结生成失败：${(exc as Error).message}`
      }
    }
    active.value = false
  }

  return { supported, active, listening, thinking, transcript, messages, observations, error, start, toggleListening, submitTurn, finish }
}
