import { Route, Routes } from 'react-router-dom'
import { TopNav } from './components/layout/TopNav'
import { MarketPage } from './features/market/MarketPage'
import { MePage } from './features/me/MePage'
import { StockPage } from './features/stock/StockPage'

export function App() {
  return (
    <div className="shell">
      <TopNav />
      <Routes>
        <Route path="/" element={<MarketPage />} />
        <Route path="/stock/:code" element={<StockPage />} />
        <Route path="/me" element={<MePage />} />
        <Route path="*" element={<MarketPage />} />
      </Routes>
      <footer className="footer">
        <div>价值奇点 ValueSingularity · 数据来源 akshare</div>
        <div className="mt-8">本工具仅用于研究与学习，不构成任何投资建议。</div>
      </footer>
    </div>
  )
}
