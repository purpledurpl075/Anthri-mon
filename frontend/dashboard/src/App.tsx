import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Login from './pages/Login'
import DeviceList from './pages/DeviceList'
import DeviceDetail from './pages/DeviceDetail'
import DiscoverPage from './pages/DiscoverPage'
import CredentialsPage from './pages/CredentialsPage'
import Layout from './components/Layout'
import ProtectedRoute from './components/ProtectedRoute'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000 } },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
            <Route path="/" element={<DeviceList />} />
            <Route path="/devices/:id" element={<DeviceDetail />} />
            <Route path="/discover" element={<DiscoverPage />} />
            <Route path="/credentials" element={<CredentialsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
