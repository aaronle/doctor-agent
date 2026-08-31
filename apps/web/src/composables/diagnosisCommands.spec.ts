import { describe, expect, it } from 'vitest'

import { runDiagnosisCommand, type DiagnosisState } from './diagnosisCommands'

const base = (): DiagnosisState => ({
  selected: [
    { name: '2型糖尿病', icd: 'E11.9' },
    { name: '高血压3级', icd: 'I10' },
  ],
  primary: '2型糖尿病',
})

describe('诊断聊天命令', () => {
  it('不是诊断命令就交还给模型，不要抢答', () => {
    // 抢答的代价很大：医生问「这个患者要不要抗凝」被当成命令吞掉，
    // 就再也拿不到模型的回答了。
    for (const text of ['帮我看看血糖', '诊断依据是什么', '添加一条备注']) {
      expect(runDiagnosisCommand(text, base())).toBeNull()
    }
  })

  describe('查看诊断', () => {
    it('列出全部并用 ★ 标主诊断', () => {
      const r = runDiagnosisCommand('查看诊断', base())!
      expect(r.reply).toContain('2型糖尿病')
      expect(r.reply).toContain('高血压3级')
      expect(r.reply).toContain('★')
      expect(r.reply).toContain('E11.9')
      // 只读命令不该动状态
      expect(r.state).toEqual(base())
    })

    it('空列表时给出可照做的提示，而不是一句「暂无」', () => {
      const r = runDiagnosisCommand('查看诊断', { selected: [], primary: '' })!
      expect(r.reply).toContain('添加诊断')
    })
  })

  describe('添加诊断', () => {
    it('支持中文冒号、英文冒号与省略冒号', () => {
      for (const text of ['添加诊断：糖尿病肾病', '添加诊断:糖尿病肾病', '添加诊断 糖尿病肾病']) {
        const r = runDiagnosisCommand(text, base())!
        expect(r.state.selected.map((d) => d.name)).toContain('糖尿病肾病')
      }
    })

    it('跟在名称后面的 ICD 码会被识别出来', () => {
      const r = runDiagnosisCommand('添加诊断：糖尿病肾病 E11.2', base())!
      const added = r.state.selected.find((d) => d.name === '糖尿病肾病')
      expect(added?.icd).toBe('E11.2')
    })

    it('重复添加不产生第二条', () => {
      const r = runDiagnosisCommand('添加诊断：2型糖尿病', base())!
      expect(r.state.selected.filter((d) => d.name === '2型糖尿病')).toHaveLength(1)
    })

    it('第一条诊断自动成为主诊断，省一步操作', () => {
      const r = runDiagnosisCommand('添加诊断：急性胃肠炎', { selected: [], primary: '' })!
      expect(r.state.primary).toBe('急性胃肠炎')
    })
  })

  describe('删除诊断', () => {
    it('按名称删除', () => {
      const r = runDiagnosisCommand('删除诊断：高血压3级', base())!
      expect(r.state.selected.map((d) => d.name)).toEqual(['2型糖尿病'])
    })

    it('删掉主诊断后主诊断要清空，不能悬空指向已删条目', () => {
      const r = runDiagnosisCommand('删除诊断：2型糖尿病', base())!
      expect(r.state.selected.map((d) => d.name)).toEqual(['高血压3级'])
      expect(r.state.primary).toBe('')
    })

    it('找不到时明确说找不到，不静默', () => {
      const r = runDiagnosisCommand('删除诊断：肺炎', base())!
      expect(r.reply).toContain('未找到')
      expect(r.state).toEqual(base())
    })
  })

  describe('设为主诊断', () => {
    it('切换主诊断', () => {
      const r = runDiagnosisCommand('设为主诊断：高血压3级', base())!
      expect(r.state.primary).toBe('高血压3级')
    })

    it('模糊匹配：说一半也认', () => {
      // 医生不会每次都打全「高血压3级」
      const r = runDiagnosisCommand('设为主诊断：高血压', base())!
      expect(r.state.primary).toBe('高血压3级')
    })

    it('不在列表里的不能设为主诊断', () => {
      const r = runDiagnosisCommand('设为主诊断：肺炎', base())!
      expect(r.reply).toContain('未找到')
      expect(r.state.primary).toBe('2型糖尿病')
    })
  })

  describe('修改诊断', () => {
    it('A 为 B 改名，保留 ICD 与主诊断身份', () => {
      const r = runDiagnosisCommand('修改诊断：2型糖尿病 为 2型糖尿病伴血糖控制不佳', base())!
      const renamed = r.state.selected[0]
      expect(renamed.name).toBe('2型糖尿病伴血糖控制不佳')
      expect(renamed.icd).toBe('E11.9')
      // 改名不该把主诊断弄丢
      expect(r.state.primary).toBe('2型糖尿病伴血糖控制不佳')
    })

    it('缺少「为」时不猜，提示正确写法', () => {
      const r = runDiagnosisCommand('修改诊断：2型糖尿病', base())!
      expect(r.reply).toContain('为')
      expect(r.state).toEqual(base())
    })
  })

  it('清空诊断连主诊断一起清', () => {
    const r = runDiagnosisCommand('清空诊断', base())!
    expect(r.state.selected).toEqual([])
    expect(r.state.primary).toBe('')
    expect(r.reply).toContain('2')
  })

  describe('确认回写', () => {
    it('四种说法都认', () => {
      for (const text of ['确认诊断', '诊断确认', '确认并回写诊断', '回写诊断']) {
        expect(runDiagnosisCommand(text, base())?.writeBack).toBe(true)
      }
    })

    it('没有诊断时不触发回写，先让医生添加', () => {
      const r = runDiagnosisCommand('确认诊断', { selected: [], primary: '' })!
      expect(r.writeBack).toBeFalsy()
      expect(r.reply).toContain('添加诊断')
    })

    it('没有主诊断时不触发回写 —— 回写是有后果的动作', () => {
      const r = runDiagnosisCommand('确认诊断', { selected: [{ name: '肺炎' }], primary: '' })!
      expect(r.writeBack).toBeFalsy()
      expect(r.reply).toContain('主诊断')
    })
  })

  it('命令一律不改传入的对象，避免改了一半失败留下脏状态', () => {
    const state = base()
    const snapshot = JSON.parse(JSON.stringify(state))
    runDiagnosisCommand('清空诊断', state)
    runDiagnosisCommand('删除诊断：高血压3级', state)
    runDiagnosisCommand('添加诊断：肺炎', state)
    expect(state).toEqual(snapshot)
  })
})
