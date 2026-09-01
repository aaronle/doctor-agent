import { nextTick, ref } from 'vue'
import { ElMessage } from 'element-plus'

import { api, streamSse, type KnowledgeEntry, type KnowledgeItem } from '../api'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface CopilotChatOptions {
  /** 取当前患者 id。用 getter 而不是值 —— 换患者时不能还发给上一位。 */
  patientId: () => string
  /**
   * 本地命令拦截器。返回 true 表示这条已在本地结算完，不再走模型。
   *
   * 桌面端把诊断命令（添加/删除/设为主…）挂在这里：结果必须确定，而且要
   * 立刻反映到勾选状态上；交给模型的话「删除诊断」可能被答成一段说明文字，
   * 界面纹丝不动。移动端不接这个钩子 —— 诊断面板不在场，命令执行了也看不见。
   */
  onCommand?: (text: string) => boolean
}

/**
 * 医护 Copilot 对话。
 *
 * 桌面浮层与移动端对话页共用同一份逻辑：同一个流式端点、同一套知识库匹配。
 * 抽出来之前这段只长在 AiEmrFloat 里，移动端要用就只能抄一遍 ——
 * 两份实现意味着以后修一个漏一个。
 */
export function useCopilotChat(options: CopilotChatOptions) {
  const chatInput = ref('')
  const chatMessages = ref<ChatMessage[]>([])
  const chatting = ref(false)
  const chatScrollEl = ref<HTMLElement | null>(null)

  /**
   * 每条助手回复命中的知识库条目。key 是消息下标。
   *
   * 原件靠在回复里嵌 `<a class="kb-link">` 锚点触发，我们的回复是纯文本
   * （理由是 XSS），所以改为：回复完成后拿全文去服务端做关键词匹配，
   * 命中的条目以按钮形式挂在气泡下方。不改变界面形状。
   */
  const kbHits = ref<Map<number, KnowledgeItem[]>>(new Map())
  const kbDialogOpen = ref(false)
  const kbEntry = ref<KnowledgeEntry | null>(null)
  const kbLoading = ref(false)

  async function scrollToBottom() {
    await nextTick()
    const el = chatScrollEl.value
    if (el) el.scrollTop = el.scrollHeight
  }

  async function matchKnowledge(index: number, text: string) {
    if (!text.trim()) return
    try {
      const { items } = await api.knowledgeMatch(text)
      if (items.length) kbHits.value = new Map(kbHits.value).set(index, items)
    } catch {
      // 匹配失败不影响回复本身，静默即可
    }
  }

  async function openKnowledge(key: string) {
    kbDialogOpen.value = true
    kbLoading.value = true
    kbEntry.value = null
    try {
      kbEntry.value = await api.knowledgeEntry(key)
    } catch (error) {
      ElMessage.error(`词条加载失败：${(error as Error).message}`)
      kbDialogOpen.value = false
    } finally {
      kbLoading.value = false
    }
  }

  async function sendChat(preset?: string) {
    const text = (preset ?? chatInput.value).trim()
    if (!text || chatting.value) return
    chatInput.value = ''
    chatMessages.value.push({ role: 'user', content: text })

    if (options.onCommand?.(text)) return

    chatMessages.value.push({ role: 'assistant', content: '' })
    const index = chatMessages.value.length - 1
    chatting.value = true

    try {
      await streamSse(
        '/api/emr/copilot/chat',
        {
          patient_id: options.patientId(),
          messages: chatMessages.value.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
        },
        (event) => {
          if (event.type === 'token') {
            chatMessages.value[index].content += String(event.token)
          }
        },
      )
    } catch (error) {
      chatMessages.value[index].content = `（请求失败：${(error as Error).message}）`
    } finally {
      chatting.value = false
    }
    // 回复完整后再匹配：流式过程中文本还不全，会漏掉后半段里的关键词
    void matchKnowledge(index, chatMessages.value[index].content)
  }

  return {
    chatInput,
    chatMessages,
    chatting,
    chatScrollEl,
    kbHits,
    kbDialogOpen,
    kbEntry,
    kbLoading,
    scrollToBottom,
    matchKnowledge,
    openKnowledge,
    sendChat,
  }
}
