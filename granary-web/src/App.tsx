import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { router } from './routes/router'
import { AuthGate } from './components/AuthGate'
import { FireflyAuthError } from './api/client'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      // 401 交给 AuthGate 处理；重复请求不会恢复已经失效的 Session。
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
      <AuthGate>
        <RouterProvider router={router} />
      </AuthGate>
    </QueryClientProvider>
  )
}

export default App
