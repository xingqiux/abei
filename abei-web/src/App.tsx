import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { router } from './routes/router'
import { TokenGate } from './components/TokenGate'
import { AbeiAuthError } from './api/client'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      // 401 交给 TokenGate 处理；重复请求不会恢复已经失效的令牌。
      retry: (failureCount, error) => {
        if (error instanceof AbeiAuthError) return false
        return failureCount < 1
      },
    },
  },
})

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TokenGate>
        <RouterProvider router={router} />
      </TokenGate>
    </QueryClientProvider>
  )
}

export default App
