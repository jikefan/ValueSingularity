import { useParams } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { Tag } from '../../components/ui/Tag'

const TABS = [
  ['overview', '公司画像'],
  ['financials', '财务分析'],
  ['moat', '护城河'],
  ['valuation', '估值'],
  ['growth', '增长引擎'],
  ['institutions', '机构视角'],
  ['governance', '治理'],
  ['risks', '风险排雷'],
  ['decision', '投资决策'],
] as const

export function StockPage() {
  const { code } = useParams<{ code: string }>()

  return (
    <div className="container stack" style={{ gap: 16 }}>
      <Card title={`${code ?? '未知代码'} · 个股分析`} extra={<Tag color="blue">骨架阶段</Tag>}>
        <div className="stack">
          <p className="soft">
            9 个分析维度已规划完成，正在把 demo
            里的分析引擎迁移到端口/适配器结构。先跑通数据层，再接估值与护城河。
          </p>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            {TABS.map(([key, label]) => (
              <span
                key={key}
                className="tag tag-gray"
                style={{ padding: '6px 12px', fontSize: 12 }}
              >
                {label}
              </span>
            ))}
          </div>
        </div>
      </Card>
    </div>
  )
}
