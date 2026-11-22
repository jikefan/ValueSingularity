import { Card } from '../../components/ui/Card'
import { EmptyBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'

export function MePage() {
  return (
    <div className="container">
      <Card title="我的" extra={<Tag color="amber">待接入</Tag>}>
        <EmptyBlock
          title="自选、投资日记与判断质量追踪将在数据层迁移后接入"
          hint="后端 PostgreSQL 表与自选接口已就绪，自选管理与投资日记交互将在下一阶段接入。"
        />
      </Card>
    </div>
  )
}
