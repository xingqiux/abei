import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { router } from './routes/router'
import { TokenGate } from './components/TokenGate'
import { FireflyAuthError } from './api/client'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      // 401 交给 TokenGate 处理（它会在令牌保存后重新 refetch），重试没有意义。
      retry: (failureCount, error) => {
        if (error instanceof FireflyAuthError) return false
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
