/**
 * API contract. Mirrors `apps/api/app/domain/models.py`.
 * When a model changes, change both — the API is the source of truth.
 */

export type TemperatureLevel = 'cold' | 'cool' | 'neutral' | 'warm' | 'hot'

export interface Health {
  status: string
  version: string
}

export interface IndexQuote {
  code: string
  name: string
  price: number
  change_pct: number
}

export interface MarketTemperature {
  score: number
  level: TemperatureLevel
  pe_median: number
  pe_percentile: number
  bond_yield: number
  equity_bond_spread: number
  comment: string
}

export interface IndustryFlow {
  name: string
  change_pct: number
  net_inflow: number
  companies: number
}

export interface MarketOverview {
  generated_at: string
  indices: IndexQuote[]
  temperature: MarketTemperature
  hot_industries: IndustryFlow[]
}
