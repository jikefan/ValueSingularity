interface ScoreRingProps {
  score: number
  size?: number
  stroke?: number
  label?: string
}

/** 0–100 的评分环；颜色按冷热分段，和盘面温度语义一致。 */
export function ScoreRing({ score, size = 168, stroke = 12, label }: ScoreRingProps) {
  const clamped = Math.min(100, Math.max(0, score))
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - clamped / 100)
  const color = clamped >= 70 ? 'var(--rose)' : clamped >= 40 ? 'var(--amber)' : 'var(--accent)'

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label ?? '评分'}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="rgba(126,149,170,0.16)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x="50%"
        y="48%"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="var(--white)"
        fontFamily="var(--mono)"
        fontSize={size * 0.2}
        fontWeight="600"
      >
        {Math.round(clamped)}
      </text>
      <text
        x="50%"
        y="64%"
        textAnchor="middle"
        fill="var(--muted)"
        fontSize={size * 0.075}
        letterSpacing="2"
      >
        {label ?? 'SCORE'}
      </text>
    </svg>
  )
}
