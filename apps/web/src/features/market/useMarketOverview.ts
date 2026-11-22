import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { queryKeys } from '../../lib/queryKeys'

export function useMarketOverview() {
  return useQuery({
    queryKey: queryKeys.market.overview(),
    queryFn: ({ signal }) => api.marketOverview(signal),
  })
}
