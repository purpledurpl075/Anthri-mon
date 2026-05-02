import { Navigate, Outlet } from 'react-router-dom'

export default function ProtectedRoute({ children }: { children?: React.ReactNode }) {
  if (!localStorage.getItem('token')) return <Navigate to="/login" replace />
  return <>{children ?? <Outlet />}</>
}
