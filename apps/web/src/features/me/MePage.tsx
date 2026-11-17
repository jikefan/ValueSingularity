import { Card } from '../../components/ui/Card'
import { EmptyBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'

export function MePage() {
  return (
    <div className="container">
      <Card title="我的" extra={<Tag color="amber">待接入</Tag>}>
        <EmptyBlock
          title="自选、投资日记与判断质量追踪将在数据层迁移后接入"
          hint="后端会先落 user.db（自选 / 日记 / 事件），前端再补交互。"
        />
      </Card>
    </div>
  )
}
