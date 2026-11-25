import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Tag } from '../../components/ui/Tag'

type DemoTabKey = 'watchlist' | 'journal'

export function GuestDemoPreviewCard() {
  const [activeTab, setActiveTab] = useState<DemoTabKey>('watchlist')

  return (
    <section className="me-demo-card" aria-label="交互式示范体验">
      <div className="row" style={{ justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div className="stack" style={{ gap: 4 }}>
          <div className="row" style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
            <Tag color="blue">只读示范数据</Tag>
            <strong>先翻看示例：登录后你的个人空间会长这样</strong>
          </div>
          <span className="small muted">
            可点击下方两个页签切换查看示范愿望单与示范复盘日记，登录后即可保存自己的真实记录。
          </span>
        </div>

        <div className="me-demo-tabs" role="tablist" aria-label="示范预览页签">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'watchlist'}
            className={
              activeTab === 'watchlist' ? 'seg-tab seg-tab-sm active' : 'seg-tab seg-tab-sm'
            }
            onClick={() => setActiveTab('watchlist')}
          >
            示范愿望单（2 只）
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'journal'}
            className={activeTab === 'journal' ? 'seg-tab seg-tab-sm active' : 'seg-tab seg-tab-sm'}
            onClick={() => setActiveTab('journal')}
          >
            示范复盘日记（1 笔）
          </button>
        </div>
      </div>

      {activeTab === 'watchlist' ? (
        <div className="stack" style={{ gap: 10 }} role="tabpanel" aria-label="示范愿望单">
          <div className="tk-card stack" style={{ gap: 8 }}>
            <div
              className="row"
              style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}
            >
              <div
                className="row"
                style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}
              >
                <Link className="mono link-accent" to="/stock/600519">
                  600519
                </Link>
                <strong>贵州茅台</strong>
                <span className="small muted">· 目标价 ≤ 1,400 / PE 分位 ≤ 20%</span>
              </div>
              <Tag color="green">到价邮件提醒已开启</Tag>
            </div>
            <p className="info-hint-plain">
              <strong>触发后会发生什么：</strong>
              当收盘价跌到 1,400 元以内，或估值进入近十年最便宜的 20%
              区间时，系统会自动发送站内提醒和到价邮件，平时不用天天盯盘。
            </p>
          </div>

          <div className="tk-card stack" style={{ gap: 8 }}>
            <div
              className="row"
              style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}
            >
              <div
                className="row"
                style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}
              >
                <Link className="mono link-accent" to="/stock/600900">
                  600900
                </Link>
                <strong>长江电力</strong>
                <span className="small muted">· 股息率 ≥ 3.8% / PE 分位 ≤ 50%</span>
              </div>
              <Tag color="green">到价邮件提醒已开启</Tag>
            </div>
            <p className="info-hint-plain">
              <strong>触发后会发生什么：</strong>
              当股价回调使现金股息率达到 3.8%
              以上、且估值低于历史中位数时，系统自动提醒你“高息防守垫已经到位”。
            </p>
          </div>
        </div>
      ) : (
        <div className="stack" style={{ gap: 10 }} role="tabpanel" aria-label="示范复盘日记">
          <div className="tk-card stack" style={{ gap: 10 }}>
            <div
              className="row"
              style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}
            >
              <div
                className="row"
                style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}
              >
                <Link className="mono link-accent" to="/stock/600177">
                  600177
                </Link>
                <strong>雅戈尔</strong>
                <Tag color="amber">忍住没买（先观察）</Tag>
              </div>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <Tag color="green">当时心态：冷静</Tag>
                <Tag color="blue">买前自检清单已记录</Tag>
              </div>
            </div>

            <div className="stack" style={{ gap: 6 }}>
              <p className="small">
                <strong>当时为什么忍住没买：</strong>
                表面看市盈率不到 10 倍，但“利润真相”提示近三年超过 68%
                的利润来自对外股票/股权投资，主业现金流偏弱，避免把投资波动当成主业低估。
              </p>
              <p className="small muted">
                <strong>买前自检条件：</strong>
                等主业利润占比持续回升、且表内投资类资产比例明显下降后再重新评估。
              </p>
            </div>

            <p className="info-hint-plain">
              <strong>3 个月后对照沪深 300 复盘：</strong>
              记录后 3 个月雅戈尔下跌 6.4%，同期沪深 300 上涨 3.2%。这笔“冷静放弃”帮你避开了约 9.6%
              的相对回撤。
            </p>
          </div>
        </div>
      )}
    </section>
  )
}
