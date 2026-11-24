/**
 * Public API domain types derived from generated OpenAPI schemas.
 * Never hand-write interfaces here; run `make gen-api` after changing backend models.
 */

import type { components, operations } from './openapi.gen'

export type Schemas = components['schemas']
type ScreenerQuery = NonNullable<operations['stocks_screen_stocks']['parameters']['query']>
export type Health = Schemas['Health']
export type TemperatureLevel = Schemas['TemperatureLevel']
export type IndexQuote = Schemas['IndexQuote']
export type MarketTemperature = Schemas['MarketTemperature']
export type IndustryFlow = Schemas['IndustryFlow']
export type StyleRegimeIndex = Schemas['StyleRegimeIndex']
export type CrossAssetMacroSnapshot = Schemas['CrossAssetMacroSnapshot']
export type DiscoveryThemeId = Schemas['DiscoveryThemeCard']['theme_id']
export type DiscoveryThemeMetric = Schemas['DiscoveryThemeMetric']
export type DiscoveryStockPick = Schemas['DiscoveryStockPick']
export type DiscoveryThemeCard = Schemas['DiscoveryThemeCard']
export type DiscoveryCandidateBuckets = Schemas['DiscoveryCandidateBuckets']
export type MarketDiscoveryResponse = Schemas['MarketDiscoveryResponse']
export type MarketOverview = Schemas['MarketOverview']
export type WatchlistItem = Schemas['WatchlistItem']
export type WatchlistUpsert = Schemas['WatchlistUpsert']
export type PlanTier = Schemas['PlanTier']
export type UserProfile = Schemas['UserProfile']
export type AuthConfigResponse = Schemas['AuthConfigResponse']
export type PublicEmailCodePurpose = Schemas['EmailCodeSendRequest']['purpose']
export type AuthenticatedEmailCodePurpose = Schemas['AuthenticatedEmailCodeRequest']['purpose']
export type EmailCodePurpose = PublicEmailCodePurpose | AuthenticatedEmailCodePurpose
export type EmailCodeSendRequest = Schemas['EmailCodeSendRequest']
export type AuthenticatedEmailCodeRequest = Schemas['AuthenticatedEmailCodeRequest']
export type EmailCodeSendResponse = Schemas['EmailCodeSendResponse']
export type RegisterRequest = Schemas['RegisterRequest']
export type VerifyEmailRequest = Schemas['VerifyEmailRequest']
export type PasswordResetConfirmRequest = Schemas['PasswordResetConfirmRequest']
export type PasswordChangeRequest = Schemas['PasswordChangeRequest']
export type UserProfileUpdateRequest = Schemas['UserProfileUpdateRequest']
export type DeleteAccountRequest = Schemas['DeleteAccountRequest']
export type LoginRequest = Schemas['LoginRequest']
export type TokenResponse = Schemas['TokenResponse']
export type StockMetaRecord = Schemas['StockMetaRecord']
export type StockDetail = Schemas['StockDetail']
export type JournalAction = Schemas['JournalAction']
export type FalsifyRule = Schemas['FalsifyRule']
export type JournalCreate = Schemas['JournalCreate']
export type JournalTimeCapsule = Schemas['JournalTimeCapsule']
export type JournalEntryItem = Schemas['JournalEntryItem']
export type JournalEntryComparison = Schemas['JournalEntryComparison']
export type EmotionLedgerRow = Schemas['EmotionLedgerRow']
export type ActionLedgerRow = Schemas['ActionLedgerRow']
export type DecisionLedgerReport = Schemas['DecisionLedgerReport']
export type AlertSourceType = Schemas['AlertDeliveryItem']['source_type']
export type WebhookChannel = Schemas['NotificationPreferences']['channel_type']
export type NotificationPreferences = Schemas['NotificationPreferences']
export type NotificationPreferencesUpdate = Schemas['NotificationPreferencesUpdate']
export type AlertDeliveryItem = Schemas['AlertDeliveryItem']
export type AlertScanSummary = Schemas['AlertScanSummary']
export type UserEventCreate = Schemas['UserEventCreate']
export type UserEventItem = Schemas['UserEventItem']
export type SignalLight = Schemas['CtCheckItem']['status']
export type CtRuleEvidence = Schemas['CtRuleEvidence']
export type CtCheckItem = Schemas['CtCheckItem']
export type FinancialCtSection = Schemas['FinancialCtSection']
export type AnnualReturnPoint = Schemas['AnnualReturnPoint']
export type ShareholderReturnSection = Schemas['ShareholderReturnSection']
export type ReverseDcfSensitivityRow = Schemas['ReverseDcfSensitivityRow']
export type ReverseDcfSection = Schemas['ReverseDcfSection']
export type ValuationHistoryPoint = Schemas['ValuationHistoryPoint']
export type ValuationSection = Schemas['ValuationSection']
export type AnnualFinancialTrendPoint = Schemas['AnnualFinancialTrendPoint']
export type MoatDimensionItem = Schemas['MoatDimensionItem']
export type MoatSection = Schemas['MoatSection']
export type GrowthSection = Schemas['GrowthSection']
export type RadarScoreSection = Schemas['RadarScoreSection']
export type PeerBenchmarkMetrics = Schemas['PeerBenchmarkMetrics']
export type EarningsQualityTag = Schemas['StockForensicsSection']['earnings_quality_tag']
export type AnnualEarningsDecompositionPoint = Schemas['AnnualEarningsDecompositionPoint']
export type DupontYearPoint = Schemas['DupontYearPoint']
export type CapitalAllocationSummary = Schemas['CapitalAllocationSummary']
export type ForensicFinding = Schemas['ForensicFinding']
export type StockForensicsSection = Schemas['StockForensicsSection']
export type StockSnapshotPayload = Schemas['StockSnapshotPayload']
export type StockCompareItem = Schemas['StockCompareItem']
export type CtNaReason = Schemas['CtCheckItem']['na_reason']
export type ScoringProfile = Schemas['RadarScoreSection']['scoring_profile']
export type ScreenerQualityFilter = NonNullable<ScreenerQuery['quality_filter']>
export type ScreenerSortField = NonNullable<ScreenerQuery['sort_by']>
export type ScreenerSortDir = NonNullable<ScreenerQuery['sort_dir']>
export type StockScreenerItem = Schemas['StockScreenerItem']
export type StockScreenerResponse = Schemas['StockScreenerResponse']
export type StockScreenerFilters = {
  zeroRedOnly?: boolean
  maxPePercentile?: number
  minRoe?: number
  minDividendYield?: number
  industry?: string
  q?: string
  qualityFilter?: ScreenerQualityFilter
  sortBy?: ScreenerSortField
  sortDir?: ScreenerSortDir
  limit?: number
}
export type AiExecutionMode = Schemas['DevilsAdvocateResponse']['mode']
export type CitedMetricFact = Schemas['CitedMetricFact']
export type DevilsAdvocateChallenge = Schemas['DevilsAdvocateChallenge']
export type DevilsAdvocateRequest = Schemas['DevilsAdvocateRequest']
export type AiQuotaStatus = Schemas['AiQuotaStatus']
export type DevilsAdvocateResponse = Schemas['DevilsAdvocateResponse']
export type MdaDiffRequest = Schemas['MdaDiffRequest']
export type MdaMetricShift = Schemas['MdaMetricShift']
export type MdaDiffHighlight = Schemas['MdaDiffHighlight']
export type MdaDiffResponse = Schemas['MdaDiffResponse']
export type AiPreferences = Schemas['AiPreferences']
export type AiPreferencesUpdate = Schemas['AiPreferencesUpdate']
