/**
 * Public API domain types derived from generated OpenAPI schemas.
 * Never hand-write interfaces here; run `make gen-api` after changing backend models.
 */

import type { components } from './openapi.gen'

export type Schemas = components['schemas']
export type Health = Schemas['Health']
export type TemperatureLevel = Schemas['TemperatureLevel']
export type IndexQuote = Schemas['IndexQuote']
export type MarketTemperature = Schemas['MarketTemperature']
export type IndustryFlow = Schemas['IndustryFlow']
export type MarketOverview = Schemas['MarketOverview']
export type WatchlistItem = Schemas['WatchlistItem']
export type WatchlistUpsert = Schemas['WatchlistUpsert']
export type PlanTier = Schemas['PlanTier']
export type UserProfile = Schemas['UserProfile']
export type RegisterRequest = Schemas['RegisterRequest']
export type LoginRequest = Schemas['LoginRequest']
export type TokenResponse = Schemas['TokenResponse']
export type StockMetaRecord = Schemas['StockMetaRecord']
export type StockDetail = Schemas['StockDetail']
export type JournalAction = Schemas['JournalAction']
export type FalsifyRule = Schemas['FalsifyRule']
export type JournalCreate = Schemas['JournalCreate']
export type JournalEntryItem = Schemas['JournalEntryItem']
export type UserEventCreate = Schemas['UserEventCreate']
export type UserEventItem = Schemas['UserEventItem']
