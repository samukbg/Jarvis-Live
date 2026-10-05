import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { useStore } from './store'

// Dev builds only: drive states from the console / screenshot scripts (window.__jarvis.setState(...)).
if (import.meta.env.DEV) (window as unknown as { __jarvis: typeof useStore }).__jarvis = useStore

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
