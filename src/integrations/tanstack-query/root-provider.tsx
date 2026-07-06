import { MutationCache, QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

export function getContext() {
  const queryClient = new QueryClient({
    // Surface failed mutations globally — most mutations in the app have no
    // local onError, so without this a failed server call is silent.
    mutationCache: new MutationCache({
      onError: (error) => {
        if (typeof window !== 'undefined') {
          toast.error(error instanceof Error ? error.message : String(error))
        }
      },
    }),
  })

  return {
    queryClient,
  }
}
export default function TanstackQueryProvider() {}
